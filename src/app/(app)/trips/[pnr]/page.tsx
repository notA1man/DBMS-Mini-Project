import { TripDetail } from '@/components/trip-detail';
export default async function Page({params}:{params:Promise<{pnr:string}>}) {
  const {pnr}=await params;
  return /^[A-Z0-9]{6}$/.test(pnr)?<TripDetail pnr={pnr}/>:<p>Booking not found.</p>;
}
