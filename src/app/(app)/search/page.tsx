import { Search } from '@/components/search';

const iata = (v?: string) => (v && /^[A-Z]{3}$/.test(v) ? v : undefined);

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  return <Search initial={{ from: iata(q.from), to: iata(q.to), date: q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : undefined,
    pax: q.pax && /^[1-6]$/.test(q.pax) ? q.pax : undefined, type: q.type === 'connecting' ? 'connecting' : undefined }} />;
}
