import { notFound } from 'next/navigation';
import { FlightConsole } from '@/components/ops/flight-console';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9][0-9]{0,17}$/.test(id)) notFound();
  return <FlightConsole id={id} />;
}
