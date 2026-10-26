import { notFound } from 'next/navigation';
import { CrewFlight } from '@/components/ops/crew-portal';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[1-9][0-9]{0,17}$/.test(id)) notFound();
  return <CrewFlight id={id} />;
}
