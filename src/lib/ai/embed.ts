// Model weights are downloaded once and cached locally; no paid API or remote inference.
type Extractor=(text:string,options:{pooling:'mean';normalize:true})=>Promise<{data:ArrayLike<number>}>;
let extractor:Promise<Extractor>|undefined;
export async function embed(text:string):Promise<number[]> {
  if(!extractor) {
    extractor=(async()=>{
      const {pipeline,env}=await import('@huggingface/transformers');
      env.cacheDir=process.env.EMBEDDING_CACHE_DIR || (process.env.VERCEL ? '/tmp/strata-models' : '.models');
      return await pipeline('feature-extraction',process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
        {dtype:'q8'}) as unknown as Extractor;
    })().catch(error=>{extractor=undefined;throw error;});
  }
  const output=await (await extractor)(text,{pooling:'mean',normalize:true});
  const vector=Array.from(output.data);
  if(vector.length!==384 || vector.some(x=>!Number.isFinite(x))) throw new Error('Invalid embedding dimension');
  return vector;
}
