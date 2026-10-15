import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Building } from '@firesafety/shared';
import { api } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ErrorBox, Loading } from '../components/Status';

export function BuildingDetailPage() {
  const { id = '' } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['building', id],
    queryFn: () => api.get<Building>(`/api/buildings/${encodeURIComponent(id)}`),
    retry: false,
  });
  useDocumentTitle(data?.name ?? 'מבנה');

  return (
    <section>
      <p><Link to="/">חזרה לרשימת המבנים</Link></p>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && (
        <>
          <h1>{data.name}</h1>
          <dl className="details">
            <dt>קוד</dt>
            <dd dir="ltr">{data.code}</dd>
            <dt>פקולטה</dt>
            <dd>{data.facultyName ?? '—'}</dd>
            <dt>כתובת</dt>
            <dd>{data.address ?? '—'}</dd>
          </dl>
          <p className="muted">קומות, מפות ונקודות גילוי יתווספו בשלב 3.</p>
        </>
      )}
    </section>
  );
}
