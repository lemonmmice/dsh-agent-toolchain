use std::io::{self, Write};

struct ProcessRow {
    pid: u32,
    ppid: u32,
    session: Option<u32>,
    created: Option<String>,
}

// All fields come from numeric Win32 values; created is a fixed ISO timestamp.
// No process names, command lines, environment, or other user text is emitted.
fn write_table(out: &mut impl Write, rows: &[ProcessRow]) -> io::Result<()> {
    out.write_all(b"[")?;
    for (i, row) in rows.iter().enumerate() {
        if i != 0 {
            out.write_all(b",")?;
        }
        write!(
            out,
            "{{\"pid\":{},\"ppid\":{},\"session\":",
            row.pid, row.ppid
        )?;
        match row.session {
            Some(session) => write!(out, "{session}")?,
            None => out.write_all(b"null")?,
        }
        out.write_all(b",\"created\":")?;
        match &row.created {
            Some(created) => write!(out, "\"{created}\"")?,
            None => out.write_all(b"null")?,
        }
        out.write_all(b"}")?;
    }
    out.write_all(b"]\n")
}

#[cfg(windows)]
mod windows {
    use super::ProcessRow;
    use std::{io, mem};
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, ERROR_NO_MORE_FILES, FILETIME, HANDLE, INVALID_HANDLE_VALUE, SYSTEMTIME,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            RemoteDesktop::ProcessIdToSessionId,
            SystemInformation::GetSystemTimeAsFileTime,
            Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
            Time::FileTimeToSystemTime,
        },
    };

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: constructed only from successful owning Win32 calls;
            // the handle is never copied to another owner.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn ticks(time: FILETIME) -> u64 {
        (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
    }

    fn creation_string(time: FILETIME, snapshot_time: u64) -> Option<String> {
        // A PID recycled after enumeration must not get the old row's parent
        // paired with the new process's identity. Unknown identities fail closed.
        if ticks(time) == 0 || ticks(time) > snapshot_time {
            return None;
        }
        let mut st: SYSTEMTIME = unsafe { mem::zeroed() };
        // SAFETY: both pointers reference initialized, correctly sized structures.
        if unsafe { FileTimeToSystemTime(&time, &mut st) } == 0 || st.wYear > 9999 {
            return None;
        }
        Some(format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds
        ))
    }

    fn process_creation(pid: u32, snapshot_time: u64) -> Option<String> {
        // SAFETY: read-only query access, non-inheritable handle; no remote memory access.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            // Protected processes and processes exiting during enumeration are
            // still represented, but without an identity suitable for signaling.
            return None;
        }
        let process = OwnedHandle(raw);
        let mut created: FILETIME = unsafe { mem::zeroed() };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        // SAFETY: process is live as a handle and each output pointer is valid.
        if unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return None;
        }
        creation_string(created, snapshot_time)
    }

    pub fn collect() -> io::Result<Vec<ProcessRow>> {
        let mut now: FILETIME = unsafe { mem::zeroed() };
        // SAFETY: valid FILETIME output pointer.
        unsafe { GetSystemTimeAsFileTime(&mut now) };
        let snapshot_time = ticks(now);
        // SAFETY: process-only snapshot; PID argument is ignored by this flag.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = OwnedHandle(raw);
        let mut entry: PROCESSENTRY32W = unsafe { mem::zeroed() };
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut rows = Vec::new();
        // SAFETY: snapshot is owned and entry.dwSize matches the output structure.
        let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
        loop {
            if found == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                    return Ok(rows);
                }
                // Do not publish a partial table as a successful snapshot.
                return Err(error);
            }
            let pid = entry.th32ProcessID;
            if pid != 0 {
                let mut session = 0;
                // SAFETY: valid session output pointer; failure means unknown.
                let session =
                    (unsafe { ProcessIdToSessionId(pid, &mut session) } != 0).then_some(session);
                rows.push(ProcessRow {
                    pid,
                    ppid: entry.th32ParentProcessID,
                    session,
                    created: process_creation(pid, snapshot_time),
                });
            }
            // SAFETY: the same owned snapshot and correctly sized output structure.
            found = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn creation_time_preserves_utc_milliseconds() {
            let value = 116_444_736_001_234_567_u64;
            let time = FILETIME {
                dwLowDateTime: value as u32,
                dwHighDateTime: (value >> 32) as u32,
            };
            assert_eq!(
                creation_string(time, value).as_deref(),
                Some("1970-01-01T00:00:00.123Z")
            );
            assert_eq!(creation_string(time, value - 1), None);
        }

        #[test]
        fn own_process_has_parent_session_and_stable_identity() {
            let first = collect().unwrap();
            let second = collect().unwrap();
            let pid = std::process::id();
            let a = first.iter().find(|row| row.pid == pid).unwrap();
            let b = second.iter().find(|row| row.pid == pid).unwrap();
            assert!(a.ppid > 0);
            assert!(a.session.is_some());
            assert!(a.created.is_some());
            assert_eq!(a.created, b.created);
        }
    }
}

fn run() -> io::Result<()> {
    if std::env::args_os().len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: dsh-process-table (no arguments)",
        ));
    }
    #[cfg(windows)]
    {
        let rows = windows::collect()?;
        let mut out = io::BufWriter::new(io::stdout().lock());
        write_table(&mut out, &rows)?;
        out.flush()
    }
    #[cfg(not(windows))]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Windows is required",
    ))
}

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("dsh-process-table: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fields_are_null_and_empty_table_is_an_array() {
        let mut out = Vec::new();
        write_table(&mut out, &[]).unwrap();
        assert_eq!(out, b"[]\n");
        out.clear();
        write_table(
            &mut out,
            &[ProcessRow {
                pid: 4,
                ppid: 0,
                session: None,
                created: None,
            }],
        )
        .unwrap();
        assert_eq!(
            out,
            b"[{\"pid\":4,\"ppid\":0,\"session\":null,\"created\":null}]\n"
        );
    }
}
