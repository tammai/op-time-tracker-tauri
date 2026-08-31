//! What the client actually puts on the wire.
//!
//! The unit tests pin the *encoding* of the auth header; these pin the whole
//! request as a real server receives it, reqwest included. That matters because
//! everything between "the key the user typed" and "the bytes the server reads"
//! is a place a key can be mangled — a redirect that drops the header, a
//! serialization round trip, a stray newline — and every one of those failures
//! surfaces identically as "Authentication failed (HTTP 401)", which points the
//! user at their key instead of at the app.
//!
//! A hand-rolled listener rather than a mock HTTP crate: the point is to read
//! the raw request text, and one thread parsing headers is smaller than the
//! dependency would be.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

use base64::Engine;
use op_time_tracker_lib::credentials::Credentials;
use op_time_tracker_lib::openproject::client::OpenProjectClient;

/// One captured request: the start line plus its headers.
struct CapturedRequest {
    start_line: String,
    headers: Vec<(String, String)>,
}

impl CapturedRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Serve exactly one request, answering with `body`, and hand the request back.
///
/// Bound to port 0 so the OS picks a free port — a fixed one would make the
/// suite fail when run twice concurrently.
fn serve_once(body: &'static str) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
    let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept one connection");
        let mut reader = BufReader::new(&stream);

        let mut start_line = String::new();
        reader.read_line(&mut start_line).expect("read start line");

        let mut headers = Vec::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).expect("read header") == 0 {
                break;
            }
            let line = line.trim_end().to_string();
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.push((name.trim().to_string(), value.trim().to_string()));
            }
        }

        let mut stream = stream;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
        stream.flush().ok();

        tx.send(CapturedRequest {
            start_line: start_line.trim_end().to_string(),
            headers,
        })
        .ok();
    });

    (base_url, rx)
}

fn client(base_url: &str, api_key: &str) -> OpenProjectClient {
    OpenProjectClient::with_timeout(
        Credentials {
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
        },
        Duration::from_secs(5),
    )
    .expect("client builds")
}

fn captured(rx: mpsc::Receiver<CapturedRequest>) -> CapturedRequest {
    rx.recv_timeout(Duration::from_secs(5))
        .expect("the server captured a request")
}

/// The credential the server reads back out of the auth header.
fn decoded_credential(request: &CapturedRequest) -> String {
    let header = request
        .header("authorization")
        .expect("an Authorization header");
    let encoded = header
        .strip_prefix("Basic ")
        .expect("Basic auth, not some other scheme");
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("valid base64");
    String::from_utf8(raw).expect("utf-8 credential")
}

#[tokio::test]
async fn the_probe_sends_the_key_verbatim_as_basic_apikey_auth() {
    let (base_url, rx) = serve_once(r#"{"_type":"Root"}"#);
    let key = "0123456789abcdef0123456789abcdef0123456789abcdef";

    client(&base_url, key)
        .test_connection()
        .await
        .expect("the probe succeeds against a 200");

    let request = captured(rx);
    assert_eq!(request.start_line, "GET /api/v3 HTTP/1.1");
    // The whole point: the key arrives byte-for-byte, with the literal username
    // `apikey` in front of it.
    assert_eq!(decoded_credential(&request), format!("apikey:{key}"));
    assert_eq!(request.header("accept"), Some("application/json"));
    // A GET carries no Content-Type — only writes do.
    assert_eq!(request.header("content-type"), None);
}

#[tokio::test]
async fn a_key_with_punctuation_is_not_mangled_by_the_encoding() {
    // base64 and header serialization are both places a `+`, `/`, `=` or `-`
    // could be re-encoded or truncated.
    let (base_url, rx) = serve_once(r#"{"_type":"Root"}"#);
    let key = "aB3+xY/9-_=.~key";

    client(&base_url, key)
        .test_connection()
        .await
        .expect("the probe succeeds");

    assert_eq!(decoded_credential(&captured(rx)), format!("apikey:{key}"));
}

#[tokio::test]
async fn a_base_url_with_a_path_prefix_keeps_it_and_still_authenticates() {
    // An instance served under a subpath is the case where a naive URL join
    // silently drops either the prefix or the auth.
    let (base_url, rx) = serve_once(r#"{"_type":"Root"}"#);
    let key = "prefixed-instance-key";

    client(&format!("{base_url}/op"), key)
        .test_connection()
        .await
        .expect("the probe succeeds");

    let request = captured(rx);
    assert_eq!(request.start_line, "GET /op/api/v3 HTTP/1.1");
    assert_eq!(decoded_credential(&request), format!("apikey:{key}"));
}

#[tokio::test]
async fn a_data_request_also_carries_the_key() {
    // The probe and the data path build their requests through the same helper,
    // but only asserting the probe would let the two drift.
    let (base_url, rx) =
        serve_once(r#"{"_type":"Collection","total":0,"count":0,"_embedded":{"elements":[]}}"#);
    let key = "data-request-key";

    client(&base_url, key)
        .list_statuses()
        .await
        .expect("the collection parses");

    let request = captured(rx);
    assert_eq!(request.start_line, "GET /api/v3/statuses HTTP/1.1");
    assert_eq!(decoded_credential(&request), format!("apikey:{key}"));
}
