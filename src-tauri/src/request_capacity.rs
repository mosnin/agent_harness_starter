//! Native pending-request admission. No GUI/runtime dependencies.
//! Keep CONTROL_METHODS exactly aligned with the sidecar admission contract.
use std::collections::HashMap;
use std::fmt;

pub const REGULAR_CAPACITY: usize = 256;
pub const CONTROL_CAPACITY: usize = 16;
pub const CONTROL_METHODS: [&str; 19] = [
    "approval.reply",
    "chat.stop",
    "room.stop",
    "job.cancel",
    "computer.stop",
    "local.cancel",
    "codex.cancel",
    "slack.disconnect",
    "browser.disconnect",
    "team.disconnect",
    "terminal.close",
    "helm.cancel",
    "helm.source.cancel",
    "helm.code.close",
    "helm.orca.stop",
    "work.stop",
    "spatial.cancel",
    "voice.stop",
    "ecosystem.disconnect",
];

pub fn is_control_method(method: &str) -> bool {
    CONTROL_METHODS.contains(&method)
}

pub fn is_control_request(method: &str, operation: Option<&str>) -> bool {
    is_control_method(method)
        || (method == "spatial.workflow" && matches!(operation, Some("stop" | "cancel")))
}

pub const WIRE_ID_PREFIX: &str = "native-request-";
impl RequestTicket {
    pub fn wire_id(self) -> String {
        format!("{WIRE_ID_PREFIX}{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionError {
    DuplicateId,
    RegularFull,
    ControlFull,
    TicketExhausted,
}
impl fmt::Display for AdmissionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::DuplicateId => "Request id is already pending",
            Self::RegularFull => "Too many pending regular requests",
            Self::ControlFull => "Too many pending control requests",
            Self::TicketExhausted => "Request admission ticket capacity exhausted",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestTicket(u64);
struct Entry<T> {
    value: T,
    control: bool,
    ticket: RequestTicket,
}
pub struct PendingRequests<T> {
    entries: HashMap<String, Entry<T>>,
    next_ticket: u64,
}
impl<T> Default for PendingRequests<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            next_ticket: 0,
        }
    }
}
impl<T> PendingRequests<T> {
    pub fn admit(
        &mut self,
        id: String,
        method: &str,
        operation: Option<&str>,
        value: T,
    ) -> Result<RequestTicket, AdmissionError> {
        // Do not replace a waiter, even if the new request has another class.
        if self.entries.contains_key(&id) {
            return Err(AdmissionError::DuplicateId);
        }
        let control = is_control_request(method, operation);
        let used = self
            .entries
            .values()
            .filter(|entry| entry.control == control)
            .count();
        if used
            >= if control {
                CONTROL_CAPACITY
            } else {
                REGULAR_CAPACITY
            }
        {
            return Err(if control {
                AdmissionError::ControlFull
            } else {
                AdmissionError::RegularFull
            });
        }
        self.next_ticket = self
            .next_ticket
            .checked_add(1)
            .ok_or(AdmissionError::TicketExhausted)?;
        let ticket = RequestTicket(self.next_ticket);
        self.entries.insert(
            id,
            Entry {
                value,
                control,
                ticket,
            },
        );
        Ok(ticket)
    }

    /// Only an exact native wire ticket can consume a pending response. The
    /// caller ID is returned for restoration in the response envelope.
    pub fn remove_wire(&mut self, wire_id: &str) -> Option<(String, T)> {
        let caller_id = self
            .entries
            .iter()
            .find(|(_, entry)| entry.ticket.wire_id() == wire_id)
            .map(|(id, _)| id.clone())?;
        self.remove(&caller_id).map(|value| (caller_id, value))
    }

    /// Cleanup by caller ID, never used to correlate sidecar responses.
    pub fn remove(&mut self, id: &str) -> Option<T> {
        self.entries.remove(id).map(|entry| entry.value)
    }

    /// Completion/error cleanup must not delete a newer waiter reusing that ID
    /// after the original response already consumed its entry.
    pub fn remove_if(&mut self, id: &str, ticket: RequestTicket) -> Option<T> {
        if self.entries.get(id).map(|entry| entry.ticket) != Some(ticket) {
            return None;
        }
        self.remove(id)
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        // Tickets are never reset; old wait tasks may still finish after clear.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regular_saturation_leaves_sixteen_control_slots() {
        let mut requests = PendingRequests::default();
        for i in 0..REGULAR_CAPACITY {
            requests
                .admit(format!("regular-{i}"), "work.get", None, i)
                .unwrap();
        }
        assert_eq!(
            requests.admit("regular-over".into(), "work.get", None, 1),
            Err(AdmissionError::RegularFull)
        );
        for i in 0..CONTROL_CAPACITY {
            requests
                .admit(format!("control-{i}"), "work.stop", None, i)
                .unwrap();
        }
        assert_eq!(
            requests.admit("control-over".into(), "approval.reply", None, 1),
            Err(AdmissionError::ControlFull)
        );
        assert_eq!(requests.remove("control-0"), Some(0));
        requests
            .admit("replacement-control".into(), "approval.reply", None, 9)
            .unwrap();
        assert_eq!(
            requests.admit("still-regular-full".into(), "work.get", None, 1),
            Err(AdmissionError::RegularFull)
        );
    }

    #[test]
    fn control_saturation_does_not_consume_regular_capacity() {
        let mut requests = PendingRequests::default();
        for i in 0..CONTROL_CAPACITY {
            requests
                .admit(format!("c{i}"), "chat.stop", None, ())
                .unwrap();
        }
        for i in 0..REGULAR_CAPACITY {
            requests
                .admit(format!("r{i}"), "chat.send", None, ())
                .unwrap();
        }
        requests.remove("r0");
        requests
            .admit("r-new".into(), "chat.send", None, ())
            .unwrap();
        assert_eq!(
            requests.admit("c-new".into(), "chat.stop", None, ()),
            Err(AdmissionError::ControlFull)
        );
    }

    #[test]
    fn duplicate_id_keeps_the_original_channel_waiter() {
        let mut requests = PendingRequests::default();
        let (first_tx, first_rx) = std::sync::mpsc::channel();
        let (second_tx, second_rx) = std::sync::mpsc::channel();
        requests
            .admit("same".into(), "chat.send", None, first_tx)
            .unwrap();
        assert_eq!(
            requests.admit("same".into(), "chat.stop", None, second_tx),
            Err(AdmissionError::DuplicateId)
        );
        requests
            .remove("same")
            .unwrap()
            .send("original response")
            .unwrap();
        assert_eq!(first_rx.recv().unwrap(), "original response");
        assert!(second_rx.recv().is_err());
    }

    #[test]
    fn old_cleanup_does_not_remove_a_reused_id() {
        let mut requests = PendingRequests::default();
        let old = requests
            .admit("id".into(), "work.get", None, "old")
            .unwrap();
        assert_eq!(requests.remove("id"), Some("old"));
        let new = requests
            .admit("id".into(), "work.stop", None, "new")
            .unwrap();
        assert_eq!(requests.remove_if("id", old), None);
        assert_eq!(requests.remove_if("id", new), Some("new"));
    }

    #[test]
    fn clear_releases_waiters_without_reusing_tickets() {
        let mut requests = PendingRequests::default();
        let old = requests.admit("id".into(), "work.get", None, 1).unwrap();
        requests.clear();
        let new = requests.admit("id".into(), "work.get", None, 2).unwrap();
        assert_ne!(old, new);
        assert_eq!(requests.remove_if("id", old), None);
        assert_eq!(requests.remove_if("id", new), Some(2));
    }

    #[test]
    fn only_exact_contract_methods_receive_control_capacity() {
        let expected = [
            "approval.reply",
            "chat.stop",
            "room.stop",
            "job.cancel",
            "computer.stop",
            "local.cancel",
            "codex.cancel",
            "slack.disconnect",
            "browser.disconnect",
            "team.disconnect",
            "terminal.close",
            "helm.cancel",
            "helm.source.cancel",
            "helm.code.close",
            "helm.orca.stop",
            "work.stop",
            "spatial.cancel",
            "voice.stop",
            "ecosystem.disconnect",
        ];
        assert_eq!(CONTROL_METHODS, expected);
        for method in expected {
            assert!(is_control_method(method));
        }
        for method in [
            "",
            "work.stop.extra",
            " work.stop",
            "WORK.STOP",
            "work.resume",
            "approval.request",
            "native.team.resume",
            "runtime.stop",
            "helm.stop",
        ] {
            assert!(
                !is_control_method(method),
                "unexpected control method: {method}"
            );
        }
    }

    #[test]
    fn spatial_workflow_reserves_only_stop_and_cancel() {
        for operation in [Some("stop"), Some("cancel")] {
            assert!(is_control_request("spatial.workflow", operation));
        }
        for operation in [None, Some("start"), Some("replay"), Some("STOP"), Some("")] {
            assert!(!is_control_request("spatial.workflow", operation));
        }
        let mut requests = PendingRequests::default();
        for i in 0..REGULAR_CAPACITY {
            requests
                .admit(format!("r{i}"), "spatial.workflow", Some("replay"), ())
                .unwrap();
        }
        requests
            .admit("stop".into(), "spatial.workflow", Some("stop"), ())
            .unwrap();
        assert_eq!(
            requests.admit("start".into(), "spatial.workflow", Some("start"), ()),
            Err(AdmissionError::RegularFull)
        );
    }

    #[test]
    fn delayed_response_after_timeout_cannot_consume_readmitted_caller_id() {
        let mut requests = PendingRequests::default();
        let old = requests
            .admit("caller".into(), "work.get", None, "old")
            .unwrap();
        requests.remove_if("caller", old); // timeout cleanup
        let new = requests
            .admit("caller".into(), "work.get", None, "new")
            .unwrap();
        assert_ne!(old.wire_id(), new.wire_id());
        assert_eq!(requests.remove_wire(&old.wire_id()), None);
        assert_eq!(requests.remove_wire("caller"), None);
        assert_eq!(
            requests.remove_wire(&new.wire_id()),
            Some(("caller".into(), "new"))
        );
        assert_eq!(requests.remove_wire(&new.wire_id()), None);
    }

    #[test]
    fn exhausted_ticket_counter_refuses_without_replacing_existing_waiters() {
        let mut requests = PendingRequests::default();
        requests.admit("kept".into(), "work.get", None, 1).unwrap();
        requests.next_ticket = u64::MAX;
        assert_eq!(
            requests.admit("new".into(), "work.stop", None, 2),
            Err(AdmissionError::TicketExhausted)
        );
        assert_eq!(requests.remove("kept"), Some(1));
        assert_eq!(requests.remove("new"), None);
    }
}
