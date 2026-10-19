use async_compression::tokio::bufread::{BrotliDecoder, DeflateDecoder, GzipDecoder, ZlibDecoder};
use futures_util::TryStreamExt;
use reqwest::{
    Client, Method, Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio_util::io::StreamReader;
use tokio_util::sync::CancellationToken;

pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

pub fn client() -> anyhow::Result<Client> {
    Ok(Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .gzip(false)
        .brotli(false)
        .deflate(false)
        .build()?)
}

fn allowed(url: &Url, method: &Method) -> Result<(), &'static str> {
    if !["http", "https"].contains(&url.scheme()) {
        return Err("unsupported protocol");
    }
    let decoded = percent_encoding::percent_decode_str(url.path())
        .decode_utf8()
        .map_err(|_| "invalid URL path")?;
    let path = decoded
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    let protected = path == "/api/dsh-ui-drive/approvals"
        || path.starts_with("/api/dsh-ui-drive/approvals/")
        || path == "/api/dsh-ui-drive/estop/reset";
    if protected && ![Method::GET, Method::HEAD, Method::OPTIONS].contains(method) {
        return Err("control_plane_forbidden");
    }
    Ok(())
}

async fn execute(client: &Client, args: &Value) -> Result<Value, &'static str> {
    let requested = args["url"].as_str().unwrap_or("").trim();
    let mut url = Url::parse(requested).map_err(|_| "invalid URL")?;
    let method_text = args["method"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .unwrap_or("GET")
        .trim()
        .to_uppercase();
    let mut method =
        Method::from_bytes(method_text.as_bytes()).map_err(|_| "invalid HTTP method")?;
    let mut headers = HeaderMap::new();
    if let Some(object) = args["headers"].as_object() {
        for (name, value) in object {
            if name.trim().is_empty() || value.is_null() {
                continue;
            }
            let text = if let Some(text) = value.as_str() {
                text.to_string()
            } else if let Some(items) = value.as_array() {
                items
                    .iter()
                    .map(|item| {
                        item.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| item.to_string())
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                value.to_string()
            };
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| "invalid request header")?,
                HeaderValue::from_str(&text).map_err(|_| "invalid request header")?,
            );
        }
    }
    if !headers.contains_key("accept-encoding") {
        headers.insert(
            "accept-encoding",
            HeaderValue::from_static("gzip, deflate, br"),
        );
    }
    let mut body = if method != Method::GET && method != Method::HEAD {
        args["body"]
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    } else {
        None
    };
    for hop in 0..=20 {
        allowed(&url, &method)?;
        let mut request = client
            .request(method.clone(), url.clone())
            .headers(headers.clone());
        if let Some(value) = &body {
            request = request.body(value.clone());
        }
        let response = request.send().await.map_err(|error| {
            if error.is_connect() {
                "HTTP connection failed (DNS, TCP or TLS)"
            } else if error.is_timeout() {
                "HTTP transport timeout"
            } else {
                "HTTP transport or request validation failed"
            }
        })?;
        let status = response.status();
        if [301, 302, 303, 307, 308].contains(&status.as_u16())
            && let Some(location) = response.headers().get("location")
        {
            if hop == 20 {
                return Err("redirect count exceeded");
            }
            let next = url
                .join(location.to_str().map_err(|_| "invalid redirect location")?)
                .map_err(|_| "invalid redirect URL")?;
            if next.origin() != url.origin() {
                for name in ["authorization", "proxy-authorization", "cookie", "host"] {
                    headers.remove(name);
                }
            }
            if (status.as_u16() == 303 && method != Method::HEAD)
                || ([301, 302].contains(&status.as_u16()) && method == Method::POST)
            {
                method = Method::GET;
                body = None;
                for name in [
                    "content-type",
                    "content-length",
                    "content-encoding",
                    "content-language",
                    "content-location",
                ] {
                    headers.remove(name);
                }
            }
            url = next;
            continue;
        }
        let response_headers: serde_json::Map<String, Value> = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    Value::String(String::from_utf8_lossy(value.as_bytes()).to_string()),
                )
            })
            .collect();
        let encoding = response
            .headers()
            .get("content-encoding")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        let has_body = method != Method::HEAD && ![204, 304].contains(&status.as_u16());
        let stream = response
            .bytes_stream()
            .map_err(|_| std::io::Error::other("HTTP response body failed"));
        let mut reader: Box<dyn AsyncRead + Unpin + Send> = Box::new(StreamReader::new(stream));
        if has_body {
            for coding in encoding.split(',').rev().map(str::trim) {
                reader = match coding {
                    "gzip" | "x-gzip" => Box::new(GzipDecoder::new(BufReader::new(reader))),
                    "br" => Box::new(BrotliDecoder::new(BufReader::new(reader))),
                    "deflate" => {
                        let mut buffered = BufReader::new(reader);
                        let bytes = buffered
                            .fill_buf()
                            .await
                            .map_err(|_| "HTTP response body failed")?;
                        let wrapped = bytes.first().is_some_and(|byte| byte & 0x0f == 8);
                        if wrapped {
                            Box::new(ZlibDecoder::new(buffered))
                        } else {
                            Box::new(DeflateDecoder::new(buffered))
                        }
                    }
                    _ => reader,
                };
            }
        }
        let mut retained = Vec::new();
        let mut size = 0usize;
        let mut truncated = false;
        let mut chunk = [0u8; 16384];
        loop {
            let count = reader
                .read(&mut chunk)
                .await
                .map_err(|_| "HTTP response body failed")?;
            if count == 0 {
                break;
            }
            size += count;
            let keep = count.min(MAX_RESPONSE_BYTES - retained.len());
            retained.extend_from_slice(&chunk[..keep]);
            if size > MAX_RESPONSE_BYTES {
                truncated = true;
                break;
            }
        }
        let mut decoded = retained.as_slice();
        if truncated
            && let Err(error) = std::str::from_utf8(decoded)
            && error.error_len().is_none()
        {
            decoded = &decoded[..error.valid_up_to()];
        }
        let mut result = json!({"ok": true, "status": status.as_u16(), "statusText": status.canonical_reason().unwrap_or(""),
            "size": size, "sizeExact": !truncated, "retainedBytes": retained.len(), "truncated": truncated,
            "contentType": response_headers.get("content-type").and_then(Value::as_str).unwrap_or(""),
            "headers": response_headers, "body": String::from_utf8_lossy(decoded),
            "requestedUrl": requested, "finalUrl": if hop == 0 { requested.to_string() } else { url.to_string() }, "redirected": hop > 0});
        if truncated {
            result["truncationNote"] =
                json!("响应体超过 2 MiB，已停止读取；size 为已收到字节数下限，总大小未知。");
        }
        if hop > 0 {
            result["redirectNote"] = json!(format!(
                "响应来自跳转后的地址：请求 {requested} → 实际 {url}（自动跟随了 301/302/303/307/308，中间的跳转与各跳状态不在本次结果里；status/headers/body 全部属于最终地址）"
            ));
        }
        return Ok(result);
    }
    Err("redirect count exceeded")
}

pub async fn send(client: &Client, args: &Value, cancel: &CancellationToken) -> Value {
    let started = Instant::now();
    let timeout_ms = args["timeoutMs"]
        .as_f64()
        .unwrap_or(30000.0)
        .round()
        .clamp(1.0, 120000.0) as u64;
    let mut result = tokio::select! {
        biased;
        _ = cancel.cancelled() => json!({"ok": false, "cancelled": true, "error": "request cancelled"}),
        response = tokio::time::timeout(Duration::from_millis(timeout_ms), execute(client, args)) => match response {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                let mut failure = json!({"ok": false, "error": error});
                if error == "control_plane_forbidden" { failure["errorCode"] = json!(error); }
                failure
            },
            Err(_) => json!({"ok": false, "error": format!("timeout after {timeout_ms}ms")}),
        }
    };
    result["durationMs"] = json!(started.elapsed().as_millis() as u64);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_endpoints_and_protocols() {
        for path in [
            "/api/dsh-ui-drive/approvals",
            "/api/dsh-ui-drive/%61pprovals/abc",
            "/API/DSH-UI-DRIVE/estop/reset/",
        ] {
            let url = Url::parse(&format!("http://localhost{path}")).unwrap();
            assert_eq!(allowed(&url, &Method::POST), Err("control_plane_forbidden"));
            assert!(allowed(&url, &Method::GET).is_ok());
        }
        assert!(allowed(&Url::parse("file:///test").unwrap(), &Method::GET).is_err());
    }
}
