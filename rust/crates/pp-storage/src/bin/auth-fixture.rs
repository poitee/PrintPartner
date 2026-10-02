use anyhow::{Result, anyhow, bail};
use pp_storage::{
    Limits, WriterOwner,
    auth::{FirstUserTenant, Outcome, Provider, Request, Secret},
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::Path,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

fn string(value: &Value, key: &str) -> Result<String> {
    value[key]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("Missing request field"))
}
fn secret(value: &Value, key: &str) -> Result<Secret> {
    Ok(Secret::new(string(value, key)?))
}
fn provider(value: &Value) -> Result<Provider> {
    Ok(match value["provider"].as_str().unwrap_or("email") {
        "email" => Provider::Email,
        "github" => Provider::Github,
        "discord" => Provider::Discord,
        _ => bail!("Invalid provider"),
    })
}
fn request(v: &Value) -> Result<Request> {
    Ok(
        match v["op"]
            .as_str()
            .ok_or_else(|| anyhow!("Missing operation"))?
        {
            "register" => Request::Register {
                email: string(v, "email")?,
                display_name: string(v, "display_name")?,
                password: secret(v, "password")?,
            },
            "login" => Request::Login {
                email: string(v, "email")?,
                password: secret(v, "password")?,
            },
            "resolve_session" => Request::ResolveSession {
                token: secret(v, "token")?,
                provider: provider(v)?,
            },
            "logout" => Request::Logout {
                token: secret(v, "token")?,
            },
            "logout_all" => Request::LogoutAll {
                session: secret(v, "session")?,
            },
            "change_password" => Request::ChangePassword {
                session: secret(v, "session")?,
                current: secret(v, "current")?,
                replacement: secret(v, "replacement")?,
            },
            "request_reset" => Request::RequestReset {
                email: string(v, "email")?,
            },
            "reset_password" => Request::ResetPassword {
                token: secret(v, "token")?,
                replacement: secret(v, "replacement")?,
            },
            "oauth_login" => Request::OAuthLogin {
                provider: provider(v)?,
                provider_user_id: string(v, "provider_user_id")?,
                email: v["email"].as_str().map(str::to_owned),
                display_name: string(v, "display_name")?,
            },
            "link_identity" => Request::LinkIdentity {
                session: secret(v, "session")?,
                provider: provider(v)?,
                provider_user_id: string(v, "provider_user_id")?,
            },
            "list_keys" => Request::ListKeys {
                session: secret(v, "session")?,
            },
            "create_key" => Request::CreateKey {
                session: secret(v, "session")?,
            },
            "revoke_key" => Request::RevokeKey {
                session: secret(v, "session")?,
                key_id: string(v, "key_id")?,
            },
            "rotate_key" => Request::RotateKey {
                session: secret(v, "session")?,
                key_id: string(v, "key_id")?,
            },
            "resolve_key" => Request::ResolveKey {
                tenant_id: string(v, "tenant_id")?,
                key: secret(v, "key")?,
            },
            _ => bail!("Unknown operation"),
        },
    )
}
fn output(outcome: Outcome) -> Value {
    match outcome {
        Outcome::Status(status) => json!({"status":status}),
        Outcome::IdentityExists(exists) => json!({"exists":exists}),
        Outcome::Session { user, token } => json!({"user":user,"token":token.expose()}),
        Outcome::User(user) => json!({"user":user}),
        Outcome::ResetToken(token) => json!({"token":token.as_ref().map(Secret::expose)}),
        Outcome::Changed(changed) => json!({"changed":changed}),
        Outcome::Keys { keys, commit } => json!({"keys":keys,"commit":commit}),
        Outcome::KeyChanged { changed, commit } => json!({"changed":changed,"commit":commit}),
        Outcome::KeyCreated { info, key } => json!({"info":info,"key":key.expose()}),
        Outcome::KeyResolved { principal, commit } => {
            json!({"principal":principal,"commit":commit})
        }
    }
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let directory = args
        .get(1)
        .ok_or_else(|| anyhow!("Data directory required"))?;
    let (owner, _) = WriterOwner::open(Path::new(directory), Limits::default())?;
    let client = owner.auth(if args.get(2).is_some_and(|v| v == "claim-default") {
        FirstUserTenant::ClaimDefault
    } else {
        FirstUserTenant::NewUser
    });
    println!("{{\"ready\":true}}");
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        if line == "shutdown" {
            break;
        }
        let result = (|| -> Result<Value> {
            let value: Value =
                serde_json::from_str(&line).map_err(|_| anyhow!("Invalid fixture request"))?;
            if value["op"] == "concurrent" {
                let requests = value["requests"]
                    .as_array()
                    .ok_or_else(|| anyhow!("Missing concurrent requests"))?;
                if requests.len() != 2 {
                    bail!("Exactly two concurrent requests required");
                }
                let mut replies = Vec::new();
                for value in requests {
                    replies.push(client.submit(
                        request(value)?,
                        Arc::new(AtomicBool::new(false)),
                        Duration::from_secs(5),
                    )?);
                }
                let outcomes: Vec<Value> = replies
                    .into_iter()
                    .map(|reply| {
                        match reply
                            .recv()
                            .map_err(|_| anyhow!("Reply lost"))
                            .and_then(|result| result)
                        {
                            Ok(outcome) => output(outcome),
                            Err(error) => json!({"error":error.to_string()}),
                        }
                    })
                    .collect();
                return Ok(json!({"outcomes":outcomes}));
            }
            let reply = client.submit(
                request(&value)?,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(5),
            )?;
            Ok(output(reply.recv().map_err(|_| anyhow!("Reply lost"))??))
        })();
        let value = match result {
            Ok(value) => value,
            Err(error) => json!({"error":error.to_string()}),
        };
        println!("{value}");
        io::stdout().flush()?;
    }
    owner.shutdown()
}
