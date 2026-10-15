import { useQuery } from '@tanstack/react-query';
import type { SystemStatus } from '@firesafety/shared';
import { api } from '../lib/api';
import { useLive } from '../lib/realtime';

/** Shown to every user: monitoring that silently stops is the most dangerous failure mode. */
export function SystemBanner() {
  const { connected } = useLive();
  const { data, error } = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatus>('/api/system/status'),
    refetchInterval: 15_000,
  });

  const problems: string[] = [];
  if (error) problems.push('אין קשר לשרת המערכת.');
  else if (!connected) problems.push('החיבור לעדכונים חיים נותק. המידע במסך עלול להיות לא עדכני. מתבצע ניסיון התחברות מחדש…');
  if (data) {
    if (data.collectors.total === 0) problems.push('לא הוגדר אף Collector. אין ניטור של רכזות.');
    else if (data.collectors.online < data.collectors.total)
      problems.push(`אין קשר ל-${data.collectors.total - data.collectors.online} מתוך ${data.collectors.total} Collectors. הניטור אינו פעיל במלואו.`);
    if (data.devices.online < data.devices.total)
      problems.push(`${data.devices.total - data.devices.online} מתוך ${data.devices.total} רכזות אינן מגיבות.`);
  }
  if (problems.length === 0) return null;
  return (
    <div className="system-banner" role="alert">
      <strong>⚠ תקלת ניטור:</strong>
      <ul>
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}
