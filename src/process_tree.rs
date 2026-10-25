//! Own local descendants as well as the directly spawned SSH/SCP process.
#[cfg(windows)]
mod platform {
    use std::{
        io,
        mem::{size_of, zeroed},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use tokio::process::Child;
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    pub struct ProcessTree {
        _job: OwnedHandle,
    }
    impl ProcessTree {
        // The child starts suspended, so it cannot create descendants before assignment.
        pub fn attach(child: &Child) -> io::Result<Self> {
            // SAFETY: Each API receives valid initialized POD or a live owned handle.
            // Successful handles are adopted exactly once and closed by OwnedHandle.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = OwnedHandle::from_raw_handle(job);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                let process = child
                    .raw_handle()
                    .ok_or_else(|| io::Error::other("Process ended before assignment"))?;
                if AssignProcessToJobObject(job.as_raw_handle(), process) == 0 {
                    return Err(io::Error::last_os_error());
                }
                let tree = Self { _job: job };
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                if snapshot == INVALID_HANDLE_VALUE {
                    return Err(io::Error::last_os_error());
                }
                let snapshot = OwnedHandle::from_raw_handle(snapshot);
                let mut entry: THREADENTRY32 = zeroed();
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                let mut found = Thread32First(snapshot.as_raw_handle(), &mut entry);
                while found != 0 {
                    if Some(entry.th32OwnerProcessID) == child.id() {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                        if thread.is_null() {
                            return Err(io::Error::last_os_error());
                        }
                        let thread = OwnedHandle::from_raw_handle(thread);
                        if ResumeThread(thread.as_raw_handle()) == u32::MAX {
                            return Err(io::Error::last_os_error());
                        }
                        return Ok(tree);
                    }
                    found = Thread32Next(snapshot.as_raw_handle(), &mut entry);
                }
                Err(io::Error::other(
                    "Could not resume the suspended child thread",
                ))
            }
        }
    }
}
#[cfg(unix)]
mod platform {
    pub struct ProcessTree {
        pid: i32,
    }
    impl ProcessTree {
        pub fn attach(child: &tokio::process::Child) -> std::io::Result<Self> {
            Ok(Self {
                pid: child
                    .id()
                    .ok_or_else(|| std::io::Error::other("Process ended before assignment"))?
                    as i32,
            })
        }
    }
    impl Drop for ProcessTree {
        fn drop(&mut self) {
            // SAFETY: A negative PID selects the isolated group created at spawn.
            unsafe {
                libc::kill(-self.pid, libc::SIGKILL);
            }
        }
    }
}
pub use platform::ProcessTree;
