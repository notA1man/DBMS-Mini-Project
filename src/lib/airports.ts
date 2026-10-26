// Static airport reference used by the public landing page (IATA lookup + globe arcs).
// Keep in sync with the airport seed data (db/postgres/init/95_seed_reference.sql / scripts/seed.ts).

export type Airport = {
  code: string;
  city: string;
  name: string;
  country: string;
  tz: string;
  lat: number;
  lon: number;
  hub?: boolean;
};

export const AIRPORTS: Airport[] = [
  { code: "BLR", city: "Bengaluru", name: "Kempegowda International", country: "IN", tz: "Asia/Kolkata", lat: 13.1986, lon: 77.7066, hub: true },
  { code: "DEL", city: "New Delhi", name: "Indira Gandhi International", country: "IN", tz: "Asia/Kolkata", lat: 28.5562, lon: 77.1, hub: true },
  { code: "BOM", city: "Mumbai", name: "Chhatrapati Shivaji Maharaj International", country: "IN", tz: "Asia/Kolkata", lat: 19.0896, lon: 72.8656, hub: true },
  { code: "MAA", city: "Chennai", name: "Chennai International", country: "IN", tz: "Asia/Kolkata", lat: 12.9941, lon: 80.1709 },
  { code: "HYD", city: "Hyderabad", name: "Rajiv Gandhi International", country: "IN", tz: "Asia/Kolkata", lat: 17.2403, lon: 78.4294 },
  { code: "CCU", city: "Kolkata", name: "Netaji Subhas Chandra Bose International", country: "IN", tz: "Asia/Kolkata", lat: 22.6547, lon: 88.4467 },
  { code: "GAU", city: "Guwahati", name: "Lokpriya Gopinath Bordoloi International", country: "IN", tz: "Asia/Kolkata", lat: 26.1061, lon: 91.5859 },
  { code: "COK", city: "Kochi", name: "Cochin International", country: "IN", tz: "Asia/Kolkata", lat: 10.152, lon: 76.4019 },
  { code: "AMD", city: "Ahmedabad", name: "Sardar Vallabhbhai Patel International", country: "IN", tz: "Asia/Kolkata", lat: 23.0772, lon: 72.6347 },
  { code: "PNQ", city: "Pune", name: "Pune International", country: "IN", tz: "Asia/Kolkata", lat: 18.5821, lon: 73.9197 },
  { code: "GOI", city: "Goa", name: "Dabolim", country: "IN", tz: "Asia/Kolkata", lat: 15.3808, lon: 73.8314 },
  { code: "JAI", city: "Jaipur", name: "Jaipur International", country: "IN", tz: "Asia/Kolkata", lat: 26.8242, lon: 75.8122 },
  { code: "LKO", city: "Lucknow", name: "Chaudhary Charan Singh International", country: "IN", tz: "Asia/Kolkata", lat: 26.7606, lon: 80.8893 },
  { code: "IXC", city: "Chandigarh", name: "Shaheed Bhagat Singh International", country: "IN", tz: "Asia/Kolkata", lat: 30.6735, lon: 76.7885 },
  { code: "TRV", city: "Thiruvananthapuram", name: "Trivandrum International", country: "IN", tz: "Asia/Kolkata", lat: 8.4821, lon: 76.9201 },
  { code: "SXR", city: "Srinagar", name: "Sheikh ul-Alam International", country: "IN", tz: "Asia/Kolkata", lat: 33.9871, lon: 74.7742 },
  { code: "DXB", city: "Dubai", name: "Dubai International", country: "AE", tz: "Asia/Dubai", lat: 25.2532, lon: 55.3657 },
  { code: "DOH", city: "Doha", name: "Hamad International", country: "QA", tz: "Asia/Qatar", lat: 25.2731, lon: 51.6081 },
  { code: "SIN", city: "Singapore", name: "Changi", country: "SG", tz: "Asia/Singapore", lat: 1.3644, lon: 103.9915 },
  { code: "KUL", city: "Kuala Lumpur", name: "Kuala Lumpur International", country: "MY", tz: "Asia/Kuala_Lumpur", lat: 2.7456, lon: 101.7099 },
  { code: "BKK", city: "Bangkok", name: "Suvarnabhumi", country: "TH", tz: "Asia/Bangkok", lat: 13.69, lon: 100.7501 },
  { code: "HKG", city: "Hong Kong", name: "Hong Kong International", country: "HK", tz: "Asia/Hong_Kong", lat: 22.308, lon: 113.9185 },
  { code: "NRT", city: "Tokyo", name: "Narita International", country: "JP", tz: "Asia/Tokyo", lat: 35.772, lon: 140.3929 },
  { code: "SYD", city: "Sydney", name: "Kingsford Smith", country: "AU", tz: "Australia/Sydney", lat: -33.9399, lon: 151.1753 },
  { code: "LHR", city: "London", name: "Heathrow", country: "GB", tz: "Europe/London", lat: 51.47, lon: -0.4543 },
  { code: "CDG", city: "Paris", name: "Charles de Gaulle", country: "FR", tz: "Europe/Paris", lat: 49.0097, lon: 2.5479 },
  { code: "FRA", city: "Frankfurt", name: "Frankfurt am Main", country: "DE", tz: "Europe/Berlin", lat: 50.0379, lon: 8.5622 },
  { code: "JFK", city: "New York", name: "John F. Kennedy International", country: "US", tz: "America/New_York", lat: 40.6413, lon: -73.7781 },
  { code: "SFO", city: "San Francisco", name: "San Francisco International", country: "US", tz: "America/Los_Angeles", lat: 37.6213, lon: -122.379 },
  { code: "CMB", city: "Colombo", name: "Bandaranaike International", country: "LK", tz: "Asia/Colombo", lat: 7.1808, lon: 79.8841 },
  { code: "KTM", city: "Kathmandu", name: "Tribhuvan International", country: "NP", tz: "Asia/Kathmandu", lat: 27.6966, lon: 85.3591 },
  { code: "MLE", city: "Malé", name: "Velana International", country: "MV", tz: "Indian/Maldives", lat: 4.1918, lon: 73.5291 },
];

export const AIRPORT_BY_CODE: Record<string, Airport> = Object.fromEntries(
  AIRPORTS.map((a) => [a.code, a]),
);

// Routes drawn on the landing-page globe (illustrative network, not live data).
export const FEATURED_ROUTES: [string, string][] = [
  ["BLR", "DEL"], ["BLR", "BOM"], ["DEL", "BOM"], ["BLR", "GAU"], ["BLR", "HYD"],
  ["DEL", "SXR"], ["BOM", "GOI"], ["BLR", "COK"], ["DEL", "CCU"], ["MAA", "DEL"],
  ["BLR", "SIN"], ["BOM", "DXB"], ["HYD", "DXB"], ["COK", "DOH"], ["MAA", "CMB"],
  ["DEL", "KTM"], ["BLR", "MLE"], ["CCU", "BKK"], ["DEL", "HKG"], ["MAA", "KUL"],
  ["DEL", "LHR"], ["BOM", "FRA"], ["DEL", "CDG"], ["DEL", "NRT"], ["BLR", "SYD"],
  ["DEL", "JFK"], ["BLR", "SFO"],
];
