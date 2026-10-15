import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Building } from '@firesafety/shared';
import { api } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { Empty, ErrorBox, Loading } from '../components/Status';

export function BuildingsPage() {
  useDocumentTitle('מבנים');
  const { data, isLoading, error } = useQuery({ queryKey: ['buildings'], queryFn: () => api.get<Building[]>('/api/buildings') });

  return (
    <section aria-labelledby="buildings-title">
      <h1 id="buildings-title">מבנים</h1>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && data.length === 0 && <Empty>לא הוקצו לך מבנים. נא לפנות למנהל המערכת.</Empty>}
      {data && data.length > 0 && (
        <table className="table">
          <caption className="sr-only">רשימת המבנים שבאחריותך</caption>
          <thead>
            <tr>
              <th scope="col">קוד</th>
              <th scope="col">שם</th>
              <th scope="col">פקולטה</th>
            </tr>
          </thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.id}>
                <td dir="ltr" className="code">{b.code}</td>
                <td><Link to={`/buildings/${b.id}`}>{b.name}</Link></td>
                <td>{b.facultyName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
