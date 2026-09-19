import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  RecordingBrowserSelection,
  ZiniaoEnvironmentSnapshot,
  ZiniaoPageSummary,
  ZiniaoStoreSummary,
} from "../../common/ziniao-recording";

import "./ziniao-environment-picker.css";

type Provider = RecordingBrowserSelection["provider"];

export function ZiniaoEnvironmentPicker({
  provider,
  selection,
  disabled = false,
  compact = false,
  onProviderChange,
  onSelectionChange,
}: {
  provider: Provider;
  selection: RecordingBrowserSelection | null;
  disabled?: boolean;
  compact?: boolean;
  onProviderChange: (provider: Provider) => void;
  onSelectionChange: (selection: RecordingBrowserSelection | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<ZiniaoEnvironmentSnapshot | null>(null);
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [stores, setStores] = useState<ZiniaoStoreSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [profileId, setProfileId] = useState("");
  const [preparationId, setPreparationId] = useState<string | null>(null);
  const [pages, setPages] = useState<ZiniaoPageSummary[]>([]);
  const [pageId, setPageId] = useState("");
  const [storeName, setStoreName] = useState<string | null>(null);
  const [allowPopups, setAllowPopups] = useState(true);
  const [approvedFrameOrigins, setApprovedFrameOrigins] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const value = await window.skillRecorder.ziniaoEnvironment();
      setSnapshot(value);
      if (!profileId && value.profiles[0]) setProfileId(value.profiles[0].id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read Ziniao status.");
    }
  }, [profileId]);

  useEffect(() => {
    void refresh();
    return window.skillRecorder.onZiniaoStatusChanged((status) => {
      setSnapshot((current) => (current ? { ...current, status } : current));
    });
  }, [refresh]);

  const search = useCallback(
    async (nextPage = 1) => {
      setBusy("search");
      setError(null);
      const result = await window.skillRecorder.searchZiniaoStores({
        page: nextPage,
        limit: 10,
        ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
      });
      if (result.ok) {
        setStores(result.stores);
        setTotal(result.total);
        setPage(result.page);
      } else setError(result.error);
      setBusy(null);
    },
    [keyword],
  );

  const prepare = useCallback(
    async (
      request:
        | { kind: "profile"; profileId: string }
        | { kind: "store"; storeId: string; expectedName: string },
    ) => {
      setBusy("prepare");
      setError(null);
      onSelectionChange(null);
      const result = await window.skillRecorder.prepareZiniao(request);
      if (!result.ok) {
        setError(result.error);
        setBusy(null);
        return;
      }
      setPreparationId(result.preparationId);
      setPages(result.pages);
      setPageId(result.pages[0]?.id ?? "");
      setApprovedFrameOrigins([]);
      setStoreName(result.storeName);
      if (result.profileId) setProfileId(result.profileId);
      setBusy(null);
    },
    [onSelectionChange],
  );

  const selectPage = useCallback(async () => {
    if (!preparationId || !pageId) return;
    setBusy("select");
    setError(null);
    const result = await window.skillRecorder.selectZiniaoPage({
      preparationId,
      pageId,
      allowAssociatedPopups: allowPopups,
      approvedFrameOrigins,
    });
    if (result.ok) {
      setProfileId(result.profile.id);
      onSelectionChange(result.selection);
      await refresh();
    } else setError(result.error);
    setBusy(null);
  }, [allowPopups, approvedFrameOrigins, onSelectionChange, pageId, preparationId, refresh]);

  const pagesTotal = Math.max(1, Math.ceil(total / 10));
  const selectedPage = useMemo(
    () => pages.find((candidate) => candidate.id === pageId),
    [pageId, pages],
  );
  const ziniaoReady =
    selection?.provider === "ziniao" &&
    selection.preparationId === preparationId &&
    selection.pageId === pageId;

  return (
    <section
      className={`ziniao-picker ${compact ? "compact" : "studio"}`}
      aria-labelledby={`browser-environment-${compact ? "hud" : "studio"}`}
    >
      <div className="ziniao-picker-heading">
        <div>
          <h3 id={`browser-environment-${compact ? "hud" : "studio"}`}>
            Browser environment
          </h3>
          {!compact && (
            <p>Choose one semantic channel. Ziniao recordings stay bound to one exact store and page.</p>
          )}
        </div>
        {provider === "ziniao" && snapshot && (
          <span className="ziniao-state" data-state={snapshot.status.state}>
            {snapshot.status.state}
          </span>
        )}
      </div>

      <label className="ziniao-field">
        <span>Provider</span>
        <select
          value={provider}
          disabled={disabled || Boolean(busy)}
          onChange={(event) => {
            const next = event.target.value as Provider;
            onProviderChange(next);
            setError(null);
            if (next === "chrome" || next === "edge")
              onSelectionChange({ provider: next });
            else onSelectionChange(null);
          }}
        >
          <option value="chrome">Google Chrome</option>
          <option value="edge">Microsoft Edge</option>
          <option value="ziniao">Ziniao store browser</option>
        </select>
      </label>

      {provider === "ziniao" && (
        <div className="ziniao-flow" aria-busy={Boolean(busy)}>
          {!snapshot?.available ? (
            <div className="ziniao-message" role="status">
              {snapshot?.status.error ?? "Checking Ziniao CLI 1.0.8…"}
            </div>
          ) : (
            <>
              <div className="ziniao-profile-row">
                <label className="ziniao-field">
                  <span>Bound store</span>
                  <select
                    value={profileId}
                    disabled={disabled || Boolean(busy) || snapshot.profiles.length === 0}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    {snapshot.profiles.length === 0 ? (
                      <option value="">No bound stores</option>
                    ) : (
                      snapshot.profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.storeName} · {profile.storeId}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <button
                  type="button"
                  className="ziniao-secondary"
                  disabled={disabled || Boolean(busy) || !profileId}
                  onClick={() => void prepare({ kind: "profile", profileId })}
                >
                  {busy === "prepare" ? "Preparing…" : "Prepare"}
                </button>
                <button
                  type="button"
                  className="ziniao-link"
                  disabled={disabled || Boolean(busy)}
                  onClick={() => {
                    setShowSearch((shown) => !shown);
                    if (!showSearch && stores.length === 0) void search(1);
                  }}
                >
                  {showSearch ? "Hide stores" : "Bind another store"}
                </button>
              </div>

              {showSearch && (
                <div className="ziniao-search">
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void search(1);
                    }}
                  >
                    <label className="ziniao-field">
                      <span>Search stores</span>
                      <input
                        type="search"
                        value={keyword}
                        maxLength={256}
                        disabled={disabled || Boolean(busy)}
                        placeholder="Exact or partial store name"
                        onChange={(event) => setKeyword(event.target.value)}
                      />
                    </label>
                    <button type="submit" className="ziniao-secondary" disabled={disabled || Boolean(busy)}>
                      Search
                    </button>
                  </form>
                  {stores.length === 0 ? (
                    <p className="ziniao-empty">No stores on this page.</p>
                  ) : (
                    <ul className="ziniao-store-list">
                      {stores.map((store) => (
                        <li key={store.storeId}>
                          <div>
                            <strong>{store.storeName}</strong>
                            <span>{store.platformName} · {store.storeId}</span>
                          </div>
                          <button
                            type="button"
                            className="ziniao-secondary"
                            disabled={disabled || Boolean(busy)}
                            onClick={() =>
                              void prepare({
                                kind: "store",
                                storeId: store.storeId,
                                expectedName: store.storeName,
                              })
                            }
                          >
                            Bind and prepare
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="ziniao-pagination" aria-label="Store pages">
                    <button type="button" disabled={page <= 1 || Boolean(busy)} onClick={() => void search(page - 1)}>Previous</button>
                    <span>Page {page} of {pagesTotal}</span>
                    <button type="button" disabled={page >= pagesTotal || Boolean(busy)} onClick={() => void search(page + 1)}>Next</button>
                  </div>
                </div>
              )}

              {pages.length > 0 && (
                <div className="ziniao-page-choice">
                  <label className="ziniao-field">
                    <span>Record page</span>
                    <select
                      value={pageId}
                      disabled={disabled || Boolean(busy)}
                      onChange={(event) => {
                        setPageId(event.target.value);
                        setApprovedFrameOrigins([]);
                        onSelectionChange(null);
                      }}
                    >
                      {pages.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.title} · {candidate.origin}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ziniao-checkbox">
                    <input
                      type="checkbox"
                      checked={allowPopups}
                      disabled={disabled || Boolean(busy)}
                      onChange={(event) => {
                        setAllowPopups(event.target.checked);
                        onSelectionChange(null);
                      }}
                    />
                    <span>Include associated popups on approved origins</span>
                  </label>
                  {selectedPage?.frameOrigins.map((origin) => (
                    <label className="ziniao-checkbox" key={origin}>
                      <input
                        type="checkbox"
                        checked={approvedFrameOrigins.includes(origin)}
                        disabled={disabled || Boolean(busy)}
                        onChange={(event) => {
                          setApprovedFrameOrigins((current) =>
                            event.target.checked
                              ? [...new Set([...current, origin])]
                              : current.filter((item) => item !== origin),
                          );
                          onSelectionChange(null);
                        }}
                      />
                      <span>Allow iframe origin {origin}</span>
                    </label>
                  ))}
                  <button
                    type="button"
                    className="ziniao-primary"
                    disabled={disabled || Boolean(busy) || !pageId}
                    onClick={() => void selectPage()}
                  >
                    {busy === "select" ? "Selecting…" : "Use this page"}
                  </button>
                  {selectedPage && (
                    <p className="ziniao-page-url">{selectedPage.url}</p>
                  )}
                </div>
              )}
            </>
          )}

          {busy === "prepare" && (
            <div className="ziniao-message" role="status" aria-live="polite">
              Opening the visible store if needed, then verifying its exact process, page, and capabilities. This can take up to two minutes.
              <button type="button" className="ziniao-link" onClick={() => void window.skillRecorder.cancelZiniaoPrepare()}>
                Cancel
              </button>
            </div>
          )}
          {error && <div className="ziniao-error" role="alert">{error}</div>}
          {ziniaoReady && (
            <div className="ziniao-ready" role="status">
              Ready: {storeName} · {selectedPage?.title}. Only this prepared selection will start.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
