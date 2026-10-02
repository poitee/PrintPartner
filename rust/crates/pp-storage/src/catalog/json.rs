use anyhow::Result;
use serde_json::{Map, Value};

pub(super) fn metadata(map: &Map<String, Value>) -> Result<String> {
    fn write(value: &Value, out: &mut String) -> Result<()> {
        match value {
            Value::Null => out.push_str("null"),
            Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Value::Number(value) => {
                out.push_str(ryu_js::Buffer::new().format(value.as_f64().expect("JSON number")))
            }
            Value::String(value) => out.push_str(&serde_json::to_string(value)?),
            Value::Array(values) => {
                out.push('[');
                for (i, value) in values.iter().enumerate() {
                    if i > 0 {
                        out.push(',')
                    }
                    write(value, out)?;
                }
                out.push(']');
            }
            Value::Object(map) => {
                let mut indices = Vec::new();
                let mut other = Vec::new();
                for (key, value) in map {
                    if let Ok(index) = key.parse::<u32>()
                        && index < u32::MAX
                        && index.to_string() == *key
                    {
                        indices.push((index, key, value));
                    } else {
                        other.push((key, value));
                    }
                }
                indices.sort_unstable_by_key(|entry| entry.0);
                out.push('{');
                for (i, (key, value)) in indices
                    .into_iter()
                    .map(|(_, key, value)| (key, value))
                    .chain(other)
                    .enumerate()
                {
                    if i > 0 {
                        out.push(',')
                    }
                    out.push_str(&serde_json::to_string(key)?);
                    out.push(':');
                    write(value, out)?;
                }
                out.push('}');
            }
        }
        Ok(())
    }
    let mut out = String::new();
    write(&Value::Object(map.clone()), &mut out)?;
    Ok(out)
}
