use num_bigint::BigInt;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, BufRead, BufReader, Seek, SeekFrom},
    path::PathBuf,
    time::SystemTime,
};

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

pub fn decimal_prefix(s: &str) -> Option<f64> {
    let s = js_trim(s);
    let bytes = s.as_bytes();
    let sign = usize::from(bytes.first().is_some_and(|b| *b == b'+' || *b == b'-'));
    let count = bytes[sign..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count();
    if count == 0 {
        return None;
    }
    s[..sign + count]
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .map(|n| if n == 0.0 { 0.0 } else { n })
}
fn bits(n: f64) -> u64 {
    if n == 0.0 { 0 } else { n.to_bits() }
}
type Key = (u64, u64);

pub fn bigint(s: &str) -> Option<BigInt> {
    let s = js_trim(s);
    if s.is_empty() {
        return Some(BigInt::from(0));
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            // num-bigint accepts separators and an extra sign here; JS BigInt
            // rejects those strings, so malformed addresses must stay unresolved.
            if rest.is_empty() || !rest.chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            return BigInt::parse_bytes(rest.as_bytes(), radix);
        }
    }
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

pub struct Method {
    pub start: BigInt,
    pub end: BigInt,
    pub name: String,
}
pub fn lookup(methods: &[Method], address: &BigInt) -> Option<String> {
    let (mut lo, mut hi) = (0, methods.len());
    while lo < hi {
        // Same inclusive midpoint as the original JS lookup, including its
        // behavior for overlapping/repeated method intervals.
        let mid = lo + (hi - lo - 1) / 2;
        let m = &methods[mid];
        if m.start <= *address {
            if *address < m.end {
                return Some(m.name.clone());
            }
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    None
}
fn hex_address(s: &str) -> bool {
    s.strip_prefix("0x")
        .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn unknown(label: &str) -> bool {
    let Some((module, address)) = label.split_once('!') else {
        return false;
    };
    matches!(
        module,
        "Unknown" | "\"Unknown" | "Unknown\"" | "\"Unknown\""
    ) && hex_address(address)
}
pub fn normalize(label: &str, symbols: bool) -> String {
    let label = js_trim(label);
    let (module, function) = label.split_once('!').unwrap_or((label, ""));
    let module = if matches!(module, "" | "Unknown" | "\"Unknown\"") {
        "[unknown]"
    } else {
        module
    };
    if !symbols || function.is_empty() || hex_address(function) {
        module.to_owned()
    } else {
        format!("{module}!{function}")
    }
}

#[derive(PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
}
fn stamp(m: fs::Metadata) -> io::Result<Stamp> {
    if !m.is_file() {
        return Err(io::Error::other("trace is not a regular file"));
    }
    Ok(Stamp {
        len: m.len(),
        modified: m.modified()?,
        created: m.created().ok(),
    })
}
pub struct TraceReader {
    file: BufReader<File>,
    path: PathBuf,
    stamp: Stamp,
    eof: bool,
    after_cr: bool,
}
pub struct Batch {
    pub lines: Vec<String>,
    pub done: bool,
}

impl TraceReader {
    pub fn open(path: PathBuf) -> io::Result<Self> {
        let file = File::open(&path)?;
        let stamp = stamp(file.metadata()?)?;
        Ok(Self {
            file: BufReader::with_capacity(256 * 1024, file),
            path,
            stamp,
            eof: false,
            after_cr: false,
        })
    }
    fn unchanged(&self) -> io::Result<()> {
        if stamp(self.file.get_ref().metadata()?)? != self.stamp
            || stamp(fs::metadata(&self.path)?)? != self.stamp
        {
            return Err(io::Error::other(
                "TRACE_CHANGED: input changed during analysis; retry with a completed CSV",
            ));
        }
        Ok(())
    }
    fn line(&mut self, out: &mut Vec<u8>) -> io::Result<bool> {
        out.clear();
        // Match Node readline's CR, LF, and CRLF behavior across buffer boundaries.
        loop {
            let bytes = self.file.fill_buf()?;
            if bytes.is_empty() {
                self.eof = true;
                return Ok(!out.is_empty());
            }
            if self.after_cr {
                self.after_cr = false;
                if bytes[0] == b'\n' {
                    self.file.consume(1);
                    continue;
                }
            }
            let bytes = self.file.fill_buf()?;
            if let Some(at) = memchr::memchr2(b'\r', b'\n', bytes) {
                out.extend_from_slice(&bytes[..at]);
                self.after_cr = bytes[at] == b'\r';
                self.file.consume(at + 1);
                return Ok(true);
            }
            let n = bytes.len();
            out.extend_from_slice(bytes);
            self.file.consume(n);
        }
    }
    pub fn next_events(&mut self, event: &str) -> io::Result<Batch> {
        self.unchanged()?;
        let mut lines = Vec::new();
        let mut buffer = Vec::new();
        let mut scanned = 0;
        while !self.eof && lines.len() < 4096 && scanned < 8 * 1024 * 1024 {
            if !self.line(&mut buffer)? {
                break;
            }
            scanned += buffer.len() + 1;
            let text = String::from_utf8_lossy(&buffer);
            if text
                .split_once(',')
                .is_some_and(|(name, _)| js_trim(name) == event)
            {
                lines.push(text.into_owned());
            }
        }
        self.unchanged()?;
        Ok(Batch {
            lines,
            done: self.eof,
        })
    }
}

pub struct Options {
    pub seeds: Vec<(f64, f64, f64)>,
    pub threads: HashMap<u64, String>,
    pub methods: HashMap<String, Vec<Method>>,
    pub symbols: bool,
    pub recursion: bool,
}
impl Options {
    pub fn thread(&mut self, tid: f64, pid: String) {
        self.threads.insert(bits(tid), pid);
    }
}
pub struct Folded {
    pub entries: Vec<(String, f64)>,
    pub stacks: u32,
    pub attempted: u32,
    pub resolved: u32,
}
struct Frame {
    address: String,
    label: String,
}
struct Folder {
    options: Options,
    seeds: HashMap<Key, f64>,
    used: HashSet<Key>,
    indices: HashMap<String, usize>,
    output: Folded,
    current: Option<Key>,
    number: f64,
    frames: Vec<Frame>,
    selected: bool,
}
impl Folder {
    fn new(options: Options) -> Self {
        let seeds = options
            .seeds
            .iter()
            .map(|&(ts, tid, w)| ((bits(ts), bits(tid)), w))
            .collect();
        Self {
            options,
            seeds,
            used: HashSet::new(),
            indices: HashMap::new(),
            output: Folded {
                entries: Vec::new(),
                stacks: 0,
                attempted: 0,
                resolved: 0,
            },
            current: None,
            number: 0.,
            frames: Vec::new(),
            selected: false,
        }
    }
    fn flush(&mut self) {
        let Some(key) = self.current else { return };
        if self.selected && !self.frames.is_empty() && self.used.insert(key) {
            let methods = self
                .options
                .threads
                .get(&key.1)
                .and_then(|pid| self.options.methods.get(pid));
            let mut frames = Vec::new();
            for frame in self.frames.iter().rev() {
                let mut resolved = None;
                if let Some(methods) = methods
                    && unknown(&frame.label)
                {
                    self.output.attempted += 1;
                    resolved = bigint(&frame.address).and_then(|addr| lookup(methods, &addr));
                    if resolved.is_some() {
                        self.output.resolved += 1;
                    }
                }
                let name =
                    resolved.unwrap_or_else(|| normalize(&frame.label, self.options.symbols));
                if !self.options.recursion || frames.last() != Some(&name) {
                    frames.push(name);
                }
            }
            let stack = frames.join(";");
            let weight = self.seeds[&key];
            if let Some(at) = self.indices.get(&stack) {
                self.output.entries[*at].1 += weight;
            } else {
                self.indices
                    .insert(stack.clone(), self.output.entries.len());
                self.output.entries.push((stack, weight));
            }
            self.output.stacks += 1;
        }
        self.frames.clear();
    }
    fn line(&mut self, line: &str) {
        let mut p = line.splitn(6, ',');
        if p.next().map(js_trim) != Some("Stack") {
            return;
        }
        let Some(ts) = p.next().and_then(decimal_prefix) else {
            return;
        };
        let Some(tid) = p.next().and_then(decimal_prefix) else {
            return;
        };
        let Some(number) = p.next().and_then(decimal_prefix) else {
            return;
        };
        let key = (bits(ts), bits(tid));
        if self.current != Some(key) || number <= self.number {
            self.flush();
            self.current = Some(key);
            self.selected = self.seeds.contains_key(&key);
        }
        self.number = number;
        if self.selected {
            self.frames.push(Frame {
                address: js_trim(p.next().unwrap_or("")).to_owned(),
                label: js_trim(p.next().unwrap_or("")).to_owned(),
            });
        }
    }
}

pub fn fold(mut reader: TraceReader, options: Options) -> io::Result<Folded> {
    reader.unchanged()?;
    reader.file.seek(SeekFrom::Start(0))?;
    reader.eof = false;
    reader.after_cr = false;
    let mut folder = Folder::new(options);
    let mut buffer = Vec::new();
    while reader.line(&mut buffer)? {
        folder.line(&String::from_utf8_lossy(&buffer));
    }
    folder.flush();
    reader.unchanged()?;
    Ok(folder.output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options() -> Options {
        Options {
            seeds: vec![(10., 7., 2.), (20., 8., 3.)],
            threads: HashMap::new(),
            methods: HashMap::new(),
            symbols: true,
            recursion: true,
        }
    }
    #[test]
    fn decimal_fields_follow_js_parse_int() {
        assert_eq!(decimal_prefix("\u{feff} +50.9suffix"), Some(50.));
        assert_eq!(decimal_prefix("-0junk"), Some(0.));
        assert_eq!(decimal_prefix("0x12"), Some(0.));
        assert_eq!(decimal_prefix("9007199254740993"), Some(9007199254740992.));
        assert_eq!(decimal_prefix("no number"), None);
        assert_eq!(decimal_prefix("\u{0085}1"), None);
    }
    #[test]
    fn large_jit_addresses_and_half_open_intervals() {
        assert_eq!(bigint("0x1_000"), None);
        assert_eq!(bigint("0x+1000"), None);
        assert_eq!(bigint("1_000"), None);
        let start = bigint("0x10000000000000001").unwrap();
        let methods = vec![Method {
            start: start.clone(),
            end: &start + 4,
            name: "exact".into(),
        }];
        assert_eq!(lookup(&methods, &start), Some("exact".into()));
        assert_eq!(lookup(&methods, &(&start + 4)), None);
        assert_eq!(normalize("\u{feff}Unknown!0xff", true), "[unknown]");
        assert_eq!(normalize("a!Generic<A,B>", true), "a!Generic<A,B>");
    }
    #[test]
    fn selected_stacks_keep_first_cluster_and_weight() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("trace.csv");
        fs::write(&path,"Stack,10,7,1,0x0,leaf!Work\nStack,10,7,2,0x0,root!Main\nStack,10,7,3,0x0,root!Main\nStack,10,7,1,0x0,duplicate!Wait\nStack,11,7,1,0x0,wait!Ignore\nStack,20,8,1,0x0,last!End").unwrap();
        let r = fold(TraceReader::open(path).unwrap(), options()).unwrap();
        assert_eq!(
            r.entries,
            vec![("root!Main;leaf!Work".into(), 2.), ("last!End".into(), 3.)]
        );
        assert_eq!(r.stacks, 2);
    }
    #[test]
    fn streaming_handles_crlf_at_buffer_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("trace.csv");
        let text =
            "x".repeat(256 * 1024 - 1) + "\r\nSampledProfile,10,a,7\rSampledProfile,20,b,8\n";
        fs::write(&path, text).unwrap();
        let mut reader = TraceReader::open(path).unwrap();
        let batch = reader.next_events("SampledProfile").unwrap();
        assert_eq!(
            batch.lines,
            vec!["SampledProfile,10,a,7", "SampledProfile,20,b,8"]
        );
        assert!(batch.done);
    }
    #[test]
    fn changed_input_is_not_returned_as_valid_analysis() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("trace.csv");
        fs::write(&path, "SampledProfile,10,a,7").unwrap();
        let mut reader = TraceReader::open(path.clone()).unwrap();
        reader.next_events("SampledProfile").unwrap();
        fs::write(path, "changed input").unwrap();
        assert!(
            fold(reader, options())
                .err()
                .unwrap()
                .to_string()
                .contains("TRACE_CHANGED")
        );
    }
}
