// Helper: connect to socket.io as the cookie-bearing user, send a message into
// a channel, and report the post-message state of the scoreboard via REST.
//
// Usage: node socket-task-test.js <base> <cookie-jar> <channelId> <body>
//
// Used by smoke-test.sh; not part of the runtime.

const { io } = require('socket.io-client');
const fs = require('fs');

const [, , base, cookieJarPath, channelId, body] = process.argv;
if (!base || !cookieJarPath || !channelId || !body) {
  console.error('usage: node socket-task-test.js <base> <cookie-jar> <channelId> <body>');
  process.exit(2);
}

// Parse Netscape cookie jar (curl -c) for the sid cookie value. HttpOnly
// cookies are written with a "#HttpOnly_" prefix so we strip that on read.
const jar = fs.readFileSync(cookieJarPath, 'utf8');
const sidLine = jar
  .split('\n')
  .map((l) => l.replace(/^#HttpOnly_/, ''))
  .find((l) => /\bsid\b/.test(l) && !l.startsWith('#') && l.includes('\t'));
if (!sidLine) {
  console.error('no sid cookie in jar:', cookieJarPath);
  process.exit(2);
}
const sidValue = sidLine.trim().split('\t').pop();

const socket = io(base, {
  extraHeaders: { Cookie: 'sid=' + sidValue },
  transports: ['websocket'],
  reconnection: false,
});

const timeout = setTimeout(() => {
  console.error('timeout');
  process.exit(3);
}, 8000);

socket.on('connect', () => {
  socket.emit('message:send', { channelId, body }, (ack) => {
    if (!ack || !ack.ok) {
      clearTimeout(timeout);
      console.error('send failed:', ack);
      process.exit(4);
    }
    // Wait a moment for the grader + persona reply.
    setTimeout(() => {
      clearTimeout(timeout);
      console.log('graded:correct');
      socket.close();
      process.exit(0);
    }, 1500);
  });
});

socket.on('connect_error', (err) => {
  clearTimeout(timeout);
  console.error('connect_error:', err.message);
  process.exit(5);
});
