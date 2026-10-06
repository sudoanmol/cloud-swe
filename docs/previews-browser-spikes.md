# Preview and hosted-browser verification

## Modal S1

Claude's retained local transcript and completed background task recorded these results on 2026-10-05:

- Connect-token routing requires a server bound to `0.0.0.0`; a loopback-only server was unreachable directly.
- The guest sees the Modal hostname. The image forwarder restores the public preview Host before reaching the app.
- The same token returned HTTP 200 after 37 minutes. This proves a lower bound, not the full token lifetime. The gateway uses a conservative ten-minute cache.
- The background lifetime check terminated its sandbox successfully.

The S1 script also exercised WebSockets and SSE. The exact initial output was not retained in this report, so the local proxy tests establish those transport behaviors without claiming another live Modal certification.

## Kernel S2

The previous implementation inspected Kernel SDK 0.119.0 and agent-browser 0.38.2 source, but no completed live Kernel spike was found in the conversation. Do not treat that inspection as a paid integration result.

The current [Kernel live-view documentation](https://www.kernel.sh/docs/browsers/live-view) documents `readOnly=true`, `KERNEL_SET_READ_ONLY`, its acknowledgement, and URL invalidation when the browser is deleted. Parent messages require an available origin in `document.referrer`; the UI therefore uses `referrerPolicy="origin"`. The SDK documents an idle timeout from 10 seconds to 72 hours and counts CDP/live-view connections as activity.

Before production use, authorize and run one real Kernel browser test for CLI config loading without local Chrome, CDP error/close presentation, headful live view, JWT scope, and profile persistence after idle deletion. Terminate the browser and remove its temporary profile afterwards.

## Release checks still requiring approval

- Rebuild and publish the Modal image, including cold-boot and restored-snapshot verification.
- Run S2 against Kernel.
- Run the requested live monorepo preview, sign-up, human GitHub handoff, fresh-snapshot resume, and pause/resume scenario. Terminate all test sandboxes and browsers afterwards.

Local tests cover host parsing, capability validation and revocation, HTTP/WebSocket forwarding, token refresh, ownership gates, activity debounce, durable handoff transitions, UI event replay, handoff rendering, and Temporal wait deferral. They do not certify live provider behavior.
