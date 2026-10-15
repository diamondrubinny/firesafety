const dateTime = new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'medium' });

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
