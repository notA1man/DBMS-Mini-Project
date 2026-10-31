import { beforeAll,afterAll,test,expect } from 'vitest';
import { MongoClient,ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { initCommercialMongo,feedbackScorecard } from '../../../db/mongo/commercial';
import { deliverCommercialNotification } from '../../lib/outbox/commercial';
process.loadEnvFile('.env');
const client=new MongoClient(process.env.MONGODB_URI!);
const db=client.db(`strata_commercial_test_${randomUUID().replaceAll('-','')}`);
let created=false;
beforeAll(async()=>{await client.connect();await initCommercialMongo(db);created=true;await initCommercialMongo(db);});
afterAll(async()=>{if(created)await db.dropDatabase();await client.close();});
const review=()=>({_id:new ObjectId(),bookingId:'ABC123',flightId:'1',passengerId:'1',route:'BLR-BOM',
  ratings:{punctuality:4,crew:5,seat:4,food:3,overall:4},comment:'The cabin crew were very helpful.',tags:['crew'],sentiment:'positive',createdAt:new Date(),embeddingStatus:'pending'});
test('strict validators reject malformed ratings, dates and flight identifiers',async()=>{
  await expect(db.collection('feedback').insertOne({...review(),ratings:{overall:6}})).rejects.toMatchObject({code:121});
  await expect(db.collection('feedback').insertOne({...review(),createdAt:'yesterday'})).rejects.toMatchObject({code:121});
  await expect(db.collection('feedback').insertOne({...review(),flightId:1})).rejects.toMatchObject({code:121});
});
test('one feedback per traveler/booking/flight and aggregation scorecard',async()=>{
  await db.collection('feedback').insertOne(review());
  await expect(db.collection('feedback').insertOne(review())).rejects.toMatchObject({code:11000});
  const result=await db.collection('feedback').aggregate(feedbackScorecard).toArray();
  expect(result[0].byRoute[0]).toMatchObject({_id:'BLR-BOM',overall:4,reviews:1});
  expect(result[0].tags[0]).toMatchObject({_id:'crew',count:1});
});
test('notification replay preserves read state and TTL creation date',async()=>{
  const event={event_id:'1',event_type:'BOOKING_CONFIRMED',created_at:new Date(),payload:{bookingId:'ABC123',userId:'1'}};
  await deliverCommercialNotification(db,event);
  await db.collection<{_id:string}>('notifications').updateOne({_id:'outbox:1'},{$set:{read:true}});
  await deliverCommercialNotification(db,{...event,created_at:new Date(Date.now()+1000)});
  const rows=await db.collection('notifications').find().toArray();
  expect(rows).toHaveLength(1);expect(rows[0].read).toBe(true);expect(rows[0].createdAt).toEqual(event.created_at);
  expect(await deliverCommercialNotification(db,{...event,event_type:'FLIGHT_UPSERT'})).toBe(false);
  const indexes=await db.collection('notifications').indexes();
  expect(indexes.find(i=>i.expireAfterSeconds!==undefined)?.expireAfterSeconds).toBe(90*24*60*60);
});
