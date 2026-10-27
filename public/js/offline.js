import { storage } from './dom.js';

// Check-ins made without internet are kept on the phone with the time they
// happened, then replayed in order when the connection returns.

const KEY = 'fs.queue';

export const queued = () => storage.get(KEY, []);

export function enqueue(path, body = {}) {
  const queue = queued();
  queue.push({ path, body, clientTime: Date.now() });
  storage.set(KEY, queue);
}

export async function flush(api) {
  const queue = queued();
  let sent = 0;
  while (queue.length) {
    const item = queue[0];
    try {
      await api(item.path, { method: 'POST', body: { ...item.body, clientTime: item.clientTime } });
      sent += 1;
    } catch (err) {
      if (err.status === 0) break; // still offline: keep the rest for later
      // The server refused it (e.g. already checked in): drop it so the queue does not jam.
    }
    queue.shift();
    storage.set(KEY, queue);
  }
  return sent;
}
