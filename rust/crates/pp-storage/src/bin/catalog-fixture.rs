use anyhow::{Result, anyhow};
use pp_storage::{
    Limits, WriterOwner,
    auth::Secret,
    catalog::{Credentials, Request},
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::Path,
};
fn main() -> Result<()> {
    let directory = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow!("data directory required"))?;
    let (owner, _) = WriterOwner::open(Path::new(&directory), Limits::default())?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        let result = (|| -> Result<Value> {
            let mut input: Value = serde_json::from_str(&line)?;
            let auth = input
                .as_object_mut()
                .ok_or_else(|| anyhow!("object required"))?
                .remove("auth");
            let client = match auth {
                None => owner.local_source_catalog(),
                Some(a) if a.get("session").and_then(Value::as_str).is_some() => owner
                    .source_catalog(Credentials::Session(Secret::new(
                        a["session"].as_str().unwrap().into(),
                    ))),
                Some(a) => owner.source_catalog(Credentials::Key {
                    tenant_id: a["tenant_id"]
                        .as_str()
                        .ok_or_else(|| anyhow!("tenant required"))?
                        .into(),
                    key: Secret::new(
                        a["key"]
                            .as_str()
                            .ok_or_else(|| anyhow!("key required"))?
                            .into(),
                    ),
                }),
            };
            let request: Request = serde_json::from_value(input)?;
            Ok(serde_json::to_value(client.execute(request)?)?)
        })();
        match result {
            Ok(out) => println!("{}", json!({"ok":out})),
            Err(e) => println!("{}", json!({"error":e.to_string()})),
        }
        io::stdout().flush()?;
    }
    owner.shutdown()
}
