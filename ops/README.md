# ops — runtime/deploy helpers

## Loki log forwarding for pi-telegram

`pi-telegram`'s structured debug logger writes single-line JSON to `console.log`
(stdout, enabled by default, secrets redacted). In the Kubernetes deployment the
`pi` process runs inside:

```
tmux new-session -d -s pi 'while true; do pi; sleep 2; done'
```

so the pi parent's stdout goes to the **tmux pane pty** (`/dev/pts/1`), which is
**not** the container stdout the log collector (Alloy → Loki) scrapes
(PID 1's stdout, `/dev/pts/0`). Result: `kubectl logs -c pi` is empty and Loki
never receives pi-telegram logs.

### Fix (no source change required)

`pi-telegram-loki-forwarder.sh` is a self-healing supervisor (modeled on the
vscode-tunnel sidecar). Every 15s it ensures `tmux pipe-pane` mirrors the pi
window's output to the container stdout (`/proc/1/fd/1`), filtered so only
pi-telegram JSON lines pass through (no TUI escape noise). If the pipe ever drops
(tmux restart, pi reload, window recreation) it re-arms automatically.

### Deploy

The supervisor lives on the persistent home PVC at
`~/.local/bin/pi-telegram-loki-forwarder.sh`. A deployment `postStart` lifecycle
hook on the `pi` container launches it after the tmux session is up:

```bash
kubectl -n pi patch deployment pi --patch-file ops/pi-poststart-loki-forwarder-patch.json
```

The pi deployment uses `strategy: Recreate`, so applying the patch triggers one
pod restart; the new pod's `postStart` then auto-launches the forwarder.

### Verify

```
{namespace="pi",container="pi"}
{namespace="pi",container="pi"} |= "delivery.send.result"
{namespace="pi",container="pi"} | json | event="telegram.workspace.agent.end"
```
