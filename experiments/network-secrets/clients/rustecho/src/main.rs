fn probe(name: &str, client: reqwest::blocking::Client) {
    let url = format!("https://{}/echo", std::env::var("SLOW").unwrap());
    let auth = format!("Bearer {}", std::env::var("PH").unwrap());
    match client.get(&url).header("Authorization", auth).send() {
        Ok(r) => { let s = r.status(); let b = r.text().unwrap_or_default(); println!("{name}: {s} swapped={}", b.contains(&std::env::var("DUMMY").unwrap())); }
        Err(e) => println!("{name}: error {:?}", e.to_string().chars().take(140).collect::<String>()),
    }
}
fn main() {
    probe("rust reqwest native-tls (OpenSSL, system store)", reqwest::blocking::Client::builder().use_native_tls().build().unwrap());
    probe("rust reqwest rustls + webpki-roots (bundled roots)", reqwest::blocking::Client::builder().use_rustls_tls().build().unwrap());
}
