import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import config from './auth.config';
import { pool } from '@/lib/db/postgres';
import { requestBudget } from '@/server/rate-limit';

const credentials=z.object({email:z.email().max(254),password:z.string().min(12).max(72)});
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...config,
  providers: [Credentials({
    credentials: {email:{type:'email'},password:{type:'password'}},
    async authorize(input,request) {
      const parsed=credentials.safeParse(input);
      if(!parsed.success || Buffer.byteLength(parsed.data.password,'utf8')>72) return null;
      if(!await requestBudget(request,'login',20,60)) return null;
      const {rows}=await pool.query('SELECT * FROM fn_authenticate($1,$2)',[parsed.data.email,parsed.data.password]);
      const user=rows[0];
      return user ? {id:String(user.user_id),email:user.email,role:user.role} : null;
    },
  })],
});
