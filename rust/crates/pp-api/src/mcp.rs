//! Streamable HTTP MCP on the rebuild loopback listener (T-16, GRE-348).
//!
//! `/mcp` and `/api/v1/mcp` serve the pp-services product catalog through
//! rmcp. Every request needs a valid API key for the routed tenant: a session
//! cookie alone is refused, and so is a key the auth worker does not resolve
//! to that tenant (unknown, revoked or expired). Host and Origin must match
//! the listener exactly. Write tools only propose; `confirm_apply` applies.
//! LAN peers stay out until the T-14 trust classes land.

use crate::loopback::{
    LoopbackOrigin, PresentedCredential, admit, principal, rebuild_flag_enabled,
    require_api_key_tenant,
};
use anyhow::Result;
use axum::{
    Json, Router,
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use pp_services::mcp_domain::{McpSession, UnportedDomain, server_info};
use pp_storage::auth::{self, KeyPrincipal, Secret, rebuild::RebuildAuthClient};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tokio::sync::Semaphore;

const KEY_REQUIRED: &str = "Valid API key required";
/// Concurrent key checks; the auth runtime's own lease pool bounds the work.
const ADMISSION_PERMITS: usize = 64;

#[derive(Clone)]
pub struct McpHttpConfig {
    origin: String,
    host: String,
    api_key_tenant: String,
    enabled: bool,
    wait: Duration,
}

impl McpHttpConfig {
    pub fn from_startup(origin: &str, api_key_tenant: &str, flag: Option<&str>) -> Result<Self> {
        let listener = LoopbackOrigin::parse(origin)?;
        require_api_key_tenant(api_key_tenant)?;
        Ok(Self {
            origin: listener.origin,
            host: listener.host,
            api_key_tenant: api_key_tenant.into(),
            enabled: rebuild_flag_enabled(flag),
            wait: Duration::from_millis(100),
        })
    }
}

#[derive(Clone)]
struct Guard {
    config: McpHttpConfig,
    auth: RebuildAuthClient,
    admission: Arc<Semaphore>,
}

/// Mounts the MCP transport at `/mcp` and `/api/v1/mcp` when the rebuild flag
/// was on at startup. Otherwise nothing is mounted.
pub fn mcp_router(config: McpHttpConfig, auth: RebuildAuthClient) -> Router {
    if !config.enabled {
        return Router::new();
    }
    // `admit` in the guard is the authoritative Host and Origin check. rmcp's
    // own allowlists repeat the same exact listener values.
    let transport = StreamableHttpServerConfig::default()
        .with_allowed_hosts([config.host.clone()])
        .with_allowed_origins([config.origin.clone()]);
    let service = StreamableHttpService::new(
        || Ok(ProductMcp::default()),
        Arc::new(LocalSessionManager::default()),
        transport,
    );
    Router::new()
        .route_service("/mcp", service.clone())
        .route_service("/api/v1/mcp", service)
        .layer(middleware::from_fn_with_state(
            Guard {
                config,
                auth,
                admission: Arc::new(Semaphore::new(ADMISSION_PERMITS)),
            },
            guard,
        ))
}

async fn guard(
    axum::extract::State(Guard {
        config,
        auth,
        admission,
    }): axum::extract::State<Guard>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    if let Err((status, detail)) = admit(
        &config.origin,
        &config.host,
        &config.api_key_tenant,
        &request,
    ) {
        return failure(status, detail);
    }
    let Some(PresentedCredential::ApiKey { tenant, secret }) =
        principal(request.headers(), &config.api_key_tenant)
    else {
        return failure(StatusCode::UNAUTHORIZED, KEY_REQUIRED);
    };
    let Ok(permit) = admission.try_acquire_owned() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "API key check temporarily unavailable",
        );
    };
    let wait = config.wait;
    let resolved = tokio::task::spawn_blocking(move || {
        let outcome = auth
            .submit(
                auth::Request::ResolveKey {
                    tenant_id: tenant.clone(),
                    key: Secret::new(secret),
                },
                Arc::new(AtomicBool::new(false)),
                wait,
            )
            .ok()?
            .recv()
            .ok()?
            .ok()?;
        match outcome {
            auth::Outcome::KeyResolved { principal, .. } => {
                Some(principal.filter(|key| key.tenant_id == tenant))
            }
            _ => None,
        }
    })
    .await;
    drop(permit);
    match resolved {
        Ok(Some(Some(key))) => {
            // rmcp copies the request parts into each handler's context.
            request.extensions_mut().insert(key);
            next.run(request).await
        }
        Ok(Some(None)) => failure(StatusCode::UNAUTHORIZED, KEY_REQUIRED),
        _ => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "API key check temporarily unavailable",
        ),
    }
}

fn failure(status: StatusCode, detail: &str) -> Response {
    (status, Json(json!({ "detail": detail }))).into_response()
}

/// One MCP session: its own pending proposals, product tools from the catalog.
struct ProductMcp(McpSession<UnportedDomain>);

impl Default for ProductMcp {
    fn default() -> Self {
        Self(McpSession::new(UnportedDomain, None))
    }
}

fn internal(message: impl ToString) -> ErrorData {
    ErrorData::internal_error(message.to_string(), None)
}

impl ServerHandler for ProductMcp {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
        if let Ok(server) =
            serde_json::from_value::<Implementation>(server_info()["serverInfo"].clone())
        {
            info = info.with_server_info(server);
        }
        info
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = self.0.list_tools().map_err(|error| internal(error.0))?;
        serde_json::from_value(tools).map_err(internal)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        // The guard attaches the resolved key; tool calls never run without it.
        // GRE-441 scopes ported tools to this principal's tenant.
        let _caller = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<KeyPrincipal>())
            .ok_or_else(|| internal("MCP request has no resolved API key"))?;
        let arguments = request.arguments.map(Value::Object).unwrap_or(Value::Null);
        let result = self
            .0
            .call_tool(&request.name, &arguments)
            .map_err(|error| internal(error.0))?;
        let result: CallToolResult = serde_json::from_value(result.to_json()).map_err(internal)?;
        Ok(result.into())
    }
}

#[cfg(test)]
#[path = "mcp/tests.rs"]
mod tests;
