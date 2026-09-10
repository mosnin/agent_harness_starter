// Independent standard-library-only wire-correlation review. No GUI, IPC,
// listener, provider or network execution. Imports the actual capacity helper.
#[path = "request_capacity.rs"]
mod request_capacity;
use request_capacity::PendingRequests;

#[test]
fn a_timed_out_request_cannot_deliver_its_late_reply_to_a_reused_id() {
    let mut requests = PendingRequests::default();
    let first = requests.admit("reused".into(), "work.get", None, "old waiter").unwrap();
    let old_wire = first.wire_id();
    // Match timeout/join cleanup in gui.rs. It does not cancel sidecar effects.
    assert_eq!(requests.remove_if("reused", first), Some("old waiter"));
    let replacement = requests.admit("reused".into(), "work.stop", None, "new waiter").unwrap();
    let new_wire = replacement.wire_id();
    assert_ne!(old_wire, new_wire);
    // The current stdout reader uses the exact native wire ID.
    assert_eq!(requests.remove_wire(&old_wire), None);
    assert_eq!(requests.remove_if("reused", first), None);
    assert_eq!(requests.remove_wire(&new_wire), Some(("reused".into(), "new waiter")));
    assert_eq!(requests.remove_wire(&new_wire), None);
}

#[test]
fn caller_spoof_and_late_reply_after_clear_cannot_consume_new_wire_attempt() {
    let mut requests = PendingRequests::default();
    let old = requests.admit("logical".into(), "work.get", None, 1).unwrap();
    requests.clear();
    let new = requests.admit("logical".into(), "work.get", None, 2).unwrap();
    assert_eq!(requests.remove_wire("logical"), None);
    assert_eq!(requests.remove_wire(&old.wire_id()), None);
    assert_eq!(requests.remove_wire(&new.wire_id()), Some(("logical".into(), 2)));
}
