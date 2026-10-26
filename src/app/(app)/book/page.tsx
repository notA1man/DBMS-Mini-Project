import { BookingForm } from '@/components/booking-form';
export default async function Page({searchParams}:{searchParams:Promise<{flights?:string;fare?:string}>}) {
  const query=await searchParams;
  const flights=query.flights?.split(',') || [];
  if(flights.length<1 || flights.length>3 || flights.some(f=>!/^\d+$/.test(f)) || new Set(flights).size!==flights.length) return <p>Choose a flight from search first.</p>;
  return <BookingForm flights={flights} fare={['Economy','Business','First'].includes(query.fare || '')?query.fare!:'Economy'}/>;
}
