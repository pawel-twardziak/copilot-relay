// One app-wide forwarder of the broker's communication events to the window. Every open session's relay client
// receives the same pushed event; the window must get it once, so the forwarder remembers the last `max` ids.

export function createCommsForward({ send, max = 2000 }) {
  const seen = new Set(); // insertion order = age
  return (event) => {
    const id = event?.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (seen.size > max) seen.delete(seen.values().next().value);
    send("comms:event", event);
  };
}
