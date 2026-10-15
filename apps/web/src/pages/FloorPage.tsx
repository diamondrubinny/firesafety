import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { FloorDetail } from '@firesafety/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLive } from '../lib/realtime';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { CategoryBadge } from '../components/Category';
import { FloorMap, floorSummary } from '../components/FloorMap';
import { ErrorBox, Loading } from '../components/Status';

export function FloorPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const highlight = params.get('point');
  const { hasRole } = useAuth();
  const { connected } = useLive();
  const { data, isLoading, error } = useQuery({
    // Under the 'alarms' key so live alarm notifications refresh the map.
    queryKey: ['alarms', 'floor', id],
    queryFn: () => api.get<FloorDetail>(`/api/floors/${encodeURIComponent(id)}`),
    refetchInterval: connected ? false : 10_000,
    retry: false,
  });
  useDocumentTitle(data ? `${data.building.name}, ${data.floor.name}` : 'קומה');

  useEffect(() => {
    if (highlight && data) document.getElementById(`pt-row-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [highlight, data]);

  return (
    <section>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && (
        <>
          <p>
            <Link to={`/buildings/${data.building.id}`}>{data.building.name}</Link>
          </p>
          <div className="row space-between">
            <h1>{data.floor.name}</h1>
            {hasRole('FireAdmin') && <Link className="btn" to={`/admin/floors/${data.floor.id}`}>עריכת מפה ושיבוץ</Link>}
          </div>
          {data.floor.planFileId ? (
            <FloorMap planFileId={data.floor.planFileId} points={data.points} highlightId={highlight} summary={floorSummary(data.floor.name, data.points)} />
          ) : (
            <p className="muted">טרם הועלתה תוכנית לקומה זו.</p>
          )}
          <h2>נקודות בקומה</h2>
          {data.points.length === 0 ? (
            <p className="muted">לא שובצו נקודות בקומה זו.</p>
          ) : (
            <table className="table">
              <thead>
                <tr><th scope="col">מצב</th><th scope="col">נקודה</th><th scope="col">מיקום</th><th scope="col">אירוע</th></tr>
              </thead>
              <tbody>
                {data.points.map((p) => (
                  <tr key={p.id} id={`pt-row-${p.id}`} aria-current={p.id === highlight ? 'location' : undefined} className={p.id === highlight ? 'row-highlight' : undefined}>
                    <td><CategoryBadge category={p.category} /></td>
                    <td>{p.label}{p.x === null && <span className="muted small"> (לא מסומנת במפה)</span>}</td>
                    <td>{p.location ?? '—'}</td>
                    <td>{p.alarmId ? <Link to={`/alarms/${p.alarmId}`}>{p.acked ? 'אושר: פרטים' : 'לא אושר: פרטים'}</Link> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
