import type { Db, Document } from 'mongodb';

const id={bsonType:'string',pattern:'^[0-9]+$'};
const rating={bsonType:['int','double'],minimum:1,maximum:5};
export const commercialValidators:Record<string,Document>={
  feedback:{$jsonSchema:{bsonType:'object',required:['_id','bookingId','flightId','passengerId','route','ratings','comment','tags','sentiment','createdAt','embeddingStatus'],
    properties:{_id:{bsonType:'objectId'},bookingId:{bsonType:'string',pattern:'^[A-Z0-9]{6}$'},flightId:id,passengerId:id,
      route:{bsonType:'string',pattern:'^[A-Z]{3}-[A-Z]{3}$'},
      ratings:{bsonType:'object',required:['punctuality','crew','seat','food','overall'],additionalProperties:false,
        properties:{punctuality:rating,crew:rating,seat:rating,food:rating,overall:rating}},
      comment:{bsonType:'string',minLength:10,maxLength:3000},tags:{bsonType:'array',maxItems:10,uniqueItems:true,items:{bsonType:'string',maxLength:40}},
      sentiment:{enum:['positive','neutral','negative']},createdAt:{bsonType:'date'},
      embeddingStatus:{enum:['pending','ready']}}}},
  notifications:{$jsonSchema:{bsonType:'object',required:['_id','userId','kind','title','body','link','read','createdAt'],
    properties:{_id:{bsonType:'string'},userId:id,kind:{enum:['BOOKING_CONFIRMED','BOOKING_CANCELLED','FLIGHT_CANCELLED','FLIGHT_DELAYED','BOOKING_REBOOKED']},
      title:{bsonType:'string',minLength:1,maxLength:160},body:{bsonType:'string',maxLength:3000},
      link:{bsonType:'string',pattern:'^/'},read:{bsonType:'bool'},createdAt:{bsonType:'date'}}}},
};

export async function initCommercialMongo(db:Db) {
  for(const [name,validator] of Object.entries(commercialValidators)) {
    if(await db.listCollections({name}).hasNext()) {
      await db.command({collMod:name,validator,validationLevel:'strict',validationAction:'error'});
    } else await db.createCollection(name,{validator,validationLevel:'strict',validationAction:'error'});
  }
  await db.collection('feedback').createIndexes([
    {key:{bookingId:1,flightId:1,passengerId:1},unique:true,name:'one_review_per_ticket_flight'},
    {key:{flightId:1,createdAt:-1}}, {key:{route:1,createdAt:-1}}, {key:{comment:'text'}},
    {key:{embeddingStatus:1,createdAt:1}},
  ]);
  await db.collection('notifications').createIndexes([
    {key:{userId:1,read:1,createdAt:-1}}, {key:{createdAt:1},expireAfterSeconds:90*24*60*60},
  ]);
}

export const feedbackScorecard:Document[]=[{$facet:{
  byRoute:[{$group:{_id:'$route',overall:{$avg:'$ratings.overall'},reviews:{$sum:1}}},{$sort:{overall:-1}}],
  byMonth:[{$group:{_id:{$dateTrunc:{date:'$createdAt',unit:'month'}},overall:{$avg:'$ratings.overall'},reviews:{$sum:1}}},{$sort:{_id:1}}],
  tags:[{$unwind:'$tags'},{$group:{_id:'$tags',count:{$sum:1}}},{$sort:{count:-1}},{$limit:20}],
}}];
