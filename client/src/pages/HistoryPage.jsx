import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getHistory } from '../api.js';
import HistoryRow from '../components/HistoryRow.jsx';

const PAGE_LIMIT = 50;

export default function HistoryPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [filter, setFilter] = useState('');

  const loadFirstPage = useCallback(async () => {
    setError('');
    try {
      const data = await getHistory({ limit: PAGE_LIMIT, offset: 0 });
      const list = Array.isArray(data) ? data : [];
      setRows(list);
      setOffset(list.length);
      setHasMore(list.length === PAGE_LIMIT);
    } catch (err) {
      setError(err.message || 'Failed to load history');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadFirstPage().finally(() => setLoading(false));
  }, [loadFirstPage]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const data = await getHistory({ limit: PAGE_LIMIT, offset });
      const list = Array.isArray(data) ? data : [];
      setRows((prev) => [...prev, ...list]);
      setOffset((prev) => prev + list.length);
      setHasMore(list.length === PAGE_LIMIT);
    } catch (err) {
      setError(err.message || 'Failed to load more history');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, offset]);

  const handleRetry = useCallback(() => {
    setLoading(true);
    loadFirstPage().finally(() => setLoading(false));
  }, [loadFirstPage]);

  const filteredRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => (row.container_name || '').toLowerCase().includes(needle));
  }, [rows, filter]);

  return (
    <div className="history-page">
      <div className="history-header">
        <div className="title-row">
          <h2>History</h2>
          <span className="badge badge-muted">
            {filteredRows.length}
            {filteredRows.length !== rows.length ? ` / ${rows.length}` : ''}
          </span>
        </div>
        <input
          type="text"
          className="history-filter-input"
          placeholder="Filter by container name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter history by container name"
        />
      </div>

      {loading && (
        <div className="dashboard-list" aria-busy="true" aria-label="Loading history">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      )}

      {!loading && error && (
        <div className="error-state">
          <p>{error}</p>
          <button type="button" className="btn btn-primary" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && filteredRows.length === 0 && (
        <div className="empty-state">
          <p>{rows.length === 0 ? 'No updates yet.' : 'No matching containers.'}</p>
        </div>
      )}

      {!loading && !error && filteredRows.length > 0 && (
        <div className="history-list">
          {filteredRows.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {!loading && !error && hasMore && !filter && (
        <div className="history-load-more">
          <button type="button" className="btn" onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore && <span className="spinner" aria-hidden="true" />}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
