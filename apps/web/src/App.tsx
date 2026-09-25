import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type SessionMode = 'code' | 'analysis';

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

type Artifact = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  attachments: Attachment[];
  artifacts: Artifact[];
};

type Session = {
  id: string;
  title: string;
  mode: SessionMode;
  status: 'idle' | 'running' | 'error';
  createdAt: string;
  updatedAt: string;
  messages?: Message[];
};

type GatewayEvent =
  | { type: 'ready' }
  | {
      type: 'run.completed';
      runId: string;
      sessionId: string;
    }
  | {
      type: 'run.failed';
      runId: string;
      sessionId: string;
      error: string;
    };

function normalizeGatewayUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function App() {
  const [gatewayUrl, setGatewayUrl] = useState(
    () => localStorage.getItem('ew-gateway-url') || ''
  );
  const [gatewayDraft, setGatewayDraft] = useState(gatewayUrl);
  const [token, setToken] = useState(
    () => localStorage.getItem('ew-token') || ''
  );
  const [tokenDraft, setTokenDraft] = useState(token);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] =
    useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [selected, setSelected] =
    useState<Session | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [eventsConnected, setEventsConnected] =
    useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!token) return;
    void refreshSessions();
  }, [token, gatewayUrl]);

  useEffect(() => {
    if (!token || !selectedId) {
      setSelected(null);
      return;
    }
    void loadSession(selectedId);
  }, [token, gatewayUrl, selectedId]);

  useEffect(() => {
    if (!token) return;

    let stopped = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | null = null;

    const connect = (): void => {
      const base = gatewayUrl || window.location.origin;
      const url = new URL('/api/events', base);
      url.protocol =
        url.protocol === 'https:' ? 'wss:' : 'ws:';

      socket = new WebSocket(url);

      socket.onopen = () => {
        socket?.send(
          JSON.stringify({
            type: 'auth',
            token
          })
        );
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(
            String(event.data)
          ) as GatewayEvent;

          if (payload.type === 'ready') {
            setEventsConnected(true);
            void refreshSessions();
            const current = selectedIdRef.current;
            if (current) {
              void loadSession(current);
            }
            return;
          }

          if (
            payload.type === 'run.completed' ||
            payload.type === 'run.failed'
          ) {
            if (payload.type === 'run.failed') {
              setError(payload.error);
            }

            if (
              selectedIdRef.current ===
              payload.sessionId
            ) {
              void loadSession(payload.sessionId);
            }
            void refreshSessions();
          }
        } catch {
          setError('Invalid gateway event received.');
        }
      };

      socket.onclose = () => {
        setEventsConnected(false);
        if (!stopped) {
          retryTimer = window.setTimeout(
            connect,
            2_000
          );
        }
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      setEventsConnected(false);
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, [token, gatewayUrl]);

  function endpointUrl(endpoint: string): string {
    const base = normalizeGatewayUrl(gatewayUrl);
    return base ? base + endpoint : endpoint;
  }

  async function api(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const headers = new Headers(options.headers || {});
    headers.set(
      'Authorization',
      'Bearer ' + token
    );

    const response = await fetch(
      endpointUrl(endpoint),
      {
        ...options,
        headers
      }
    );

    if (response.status === 401) {
      setToken('');
      localStorage.removeItem('ew-token');
      throw new Error('Access token rejected.');
    }

    if (!response.ok) {
      const payload = await response
        .json()
        .catch(() => ({}));
      throw new Error(
        payload.error || 'Request failed.'
      );
    }

    return response;
  }

  async function refreshSessions(): Promise<void> {
    try {
      const response = await api('/api/sessions');
      const data = await response.json();
      setSessions(data.sessions);

      if (!selectedIdRef.current && data.sessions[0]) {
        setSelectedId(data.sessions[0].id);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : String(err)
      );
    }
  }

  async function loadSession(id: string): Promise<void> {
    try {
      const response = await api(
        '/api/sessions/' + id
      );
      const detail = await response.json() as Session;
      setSelected(detail);
      setBusy(detail.status === 'running');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : String(err)
      );
    }
  }

  async function createSession(
    mode: SessionMode
  ): Promise<void> {
    setError('');

    try {
      const response = await api('/api/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ mode })
      });

      const session = await response.json();
      await refreshSessions();
      setSelectedId(session.id);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : String(err)
      );
    }
  }

  async function send(): Promise<void> {
    if (
      !selectedId ||
      busy ||
      (!text.trim() && files.length === 0)
    ) {
      return;
    }

    setBusy(true);
    setError('');

    const body = new FormData();
    body.append('text', text);
    for (const file of files) {
      body.append('files', file, file.name);
    }

    try {
      await api(
        '/api/sessions/' +
          selectedId +
          '/messages',
        {
          method: 'POST',
          body
        }
      );

      setText('');
      setFiles([]);
      await loadSession(selectedId);
      await refreshSessions();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error
          ? err.message
          : String(err)
      );
      await loadSession(selectedId);
    }
  }

  function handlePaste(
    event: ClipboardEvent<HTMLTextAreaElement>
  ): void {
    const pastedFiles = Array.from(
      event.clipboardData.items
    )
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(
        (item): item is File => Boolean(item)
      );

    if (pastedFiles.length > 0) {
      setFiles((current) =>
        current.concat(pastedFiles)
      );
    }
  }

  async function downloadArtifact(
    artifact: Artifact
  ): Promise<void> {
    if (!selectedId) return;

    try {
      const response = await api(
        '/api/sessions/' +
          selectedId +
          '/artifacts/' +
          artifact.id
      );

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor =
        document.createElement('a');

      anchor.href = url;
      anchor.download = artifact.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Artifact download failed.'
      );
    }
  }

  function connect(): void {
    const normalized = normalizeGatewayUrl(
      gatewayDraft
    );

    if (
      normalized &&
      !/^https?:\/\//.test(normalized)
    ) {
      setError(
        'Gateway URL must start with http:// or https://.'
      );
      return;
    }

    if (
      !normalized &&
      window.location.hostname.endsWith(
        '.github.io'
      )
    ) {
      setError(
        'Enter the Cloudflare gateway URL.'
      );
      return;
    }

    if (tokenDraft.trim().length < 24) {
      setError('Enter the gateway access token.');
      return;
    }

    localStorage.setItem(
      'ew-gateway-url',
      normalized
    );
    localStorage.setItem(
      'ew-token',
      tokenDraft.trim()
    );

    setError('');
    setGatewayUrl(normalized);
    setToken(tokenDraft.trim());
  }

  function disconnect(): void {
    localStorage.removeItem('ew-token');
    localStorage.removeItem('ew-gateway-url');
    setToken('');
    setGatewayUrl('');
    setGatewayDraft('');
    setSessions([]);
    setSelectedId(null);
    setSelected(null);
    setBusy(false);
  }

  if (!token) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="eyebrow">
            Effective Workspace
          </div>
          <h1>Connect to your gateway</h1>
          <p>
            Enter the Cloudflare Tunnel URL and the
            access token configured on the personal Mac.
            For local development, the gateway URL may
            be left blank.
          </p>
          <input
            type="url"
            value={gatewayDraft}
            onChange={(event) =>
              setGatewayDraft(event.target.value)
            }
            placeholder="https://your-tunnel.example.com"
          />
          <input
            type="password"
            value={tokenDraft}
            onChange={(event) =>
              setTokenDraft(event.target.value)
            }
            placeholder="Gateway access token"
          />
          <button onClick={connect}>
            Connect
          </button>
          {error && (
            <div className="error">
              {error}
            </div>
          )}
        </section>
      </main>
    );
  }

  const isRunning =
    busy || selected?.status === 'running';

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="eyebrow">
            Effective Workspace
          </div>
          <h2>Sessions</h2>
          <small>
            events: {eventsConnected ? 'connected' : 'reconnecting'}
          </small>
        </div>

        <div className="new-buttons">
          <button
            onClick={() =>
              void createSession('code')
            }
          >
            + Code
          </button>
          <button
            onClick={() =>
              void createSession('analysis')
            }
          >
            + Analysis
          </button>
        </div>

        <div className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={
                'session-row ' +
                (session.id === selectedId
                  ? 'active'
                  : '')
              }
              onClick={() =>
                setSelectedId(session.id)
              }
            >
              <span>{session.title}</span>
              <small>
                {session.mode} · {session.status}
              </small>
            </button>
          ))}
        </div>

        <button
          className="ghost"
          onClick={disconnect}
        >
          Disconnect
        </button>
      </aside>

      <section className="workspace">
        {!selected ? (
          <div className="empty-state">
            Create a Code or Analysis session.
          </div>
        ) : (
          <>
            <header className="workspace-header">
              <div>
                <div className="eyebrow">
                  {selected.mode}
                </div>
                <h1>{selected.title}</h1>
              </div>
              <span
                className={
                  'status ' + selected.status
                }
              >
                {isRunning
                  ? 'running'
                  : selected.status}
              </span>
            </header>

            <div className="messages">
              {(selected.messages || []).map(
                (message) => (
                  <article
                    key={message.id}
                    className={
                      'message ' + message.role
                    }
                  >
                    <div className="message-meta">
                      {message.role}
                    </div>

                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                    >
                      {message.text}
                    </ReactMarkdown>

                    {message.attachments.length >
                      0 && (
                      <div className="chips">
                        {message.attachments.map(
                          (item) => (
                            <span
                              className="chip"
                              key={item.id}
                            >
                              {item.name}
                            </span>
                          )
                        )}
                      </div>
                    )}

                    {message.artifacts.length >
                      0 && (
                      <div className="artifacts">
                        <strong>
                          Artifacts
                        </strong>
                        {message.artifacts.map(
                          (artifact) => (
                            <button
                              key={artifact.id}
                              onClick={() =>
                                void downloadArtifact(
                                  artifact
                                )
                              }
                            >
                              {artifact.name}
                            </button>
                          )
                        )}
                      </div>
                    )}

                    {message.role ===
                      'assistant' && (
                      <button
                        className="copy-button"
                        onClick={() =>
                          void navigator.clipboard.writeText(
                            message.text
                          )
                        }
                      >
                        Copy response
                      </button>
                    )}
                  </article>
                )
              )}
            </div>

            <div className="composer">
              {files.length > 0 && (
                <div className="chips">
                  {files.map(
                    (file, index) => (
                      <button
                        className="chip removable"
                        key={
                          file.name +
                          String(index)
                        }
                        onClick={() =>
                          setFiles((current) =>
                            current.filter(
                              (_, i) =>
                                i !== index
                            )
                          )
                        }
                      >
                        {file.name} ×
                      </button>
                    )
                  )}
                </div>
              )}

              <textarea
                value={text}
                onChange={(event) =>
                  setText(event.target.value)
                }
                onPaste={handlePaste}
                placeholder="Ask Codex… Paste a screenshot directly here."
                rows={5}
              />

              <div className="composer-actions">
                <label className="file-button">
                  Attach
                  <input
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => {
                      const incoming =
                        Array.from(
                          event.target.files || []
                        );
                      setFiles((current) =>
                        current.concat(incoming)
                      );
                      event.target.value = '';
                    }}
                  />
                </label>

                <button
                  disabled={isRunning}
                  onClick={() => void send()}
                >
                  {isRunning ? 'Running…' : 'Send'}
                </button>
              </div>

              {error && (
                <div className="error">
                  {error}
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export default App;
