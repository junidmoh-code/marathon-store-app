import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, get, ref } from "firebase/database";
const app = initializeApp({apiKey:"AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo",authDomain:"marathon-club.firebaseapp.com",databaseURL:"https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",projectId:"marathon-club",storageBucket:"marathon-club.firebasestorage.app",messagingSenderId:"306270814317",appId:"1:306270814317:web:470395933121de7dbdbf64"});
await signInAnonymously(getAuth(app));
const db = getDatabase(app);
const r = await get(ref(db,"returns_log"));
const rd = r.val()||{}; const arr=Object.values(rd).filter(Boolean);
console.log("returns_log entries:", arr.length);
if(arr.length) console.log("sample:", JSON.stringify(arr[0]));
// estimate insights_log payload size
const l = await get(ref(db,"insights_log"));
const json = JSON.stringify(l.val()||{});
console.log("insights_log JSON size:", (json.length/1024/1024).toFixed(2), "MB");
const p = await get(ref(db,"products"));
console.log("products JSON size:", (JSON.stringify(p.val()||{}).length/1024/1024).toFixed(2), "MB");
// distribution: products by store/hub for filter design
const prods=Object.values(p.val()||{}).filter(Boolean);
const types={}; const cats={};
for(const x of prods){types[x.productType||"(unset)"]=(types[x.productType||"(unset)"]||0)+1; const c=(x.category||"(empty)"); cats[c]=(cats[c]||0)+1;}
console.log("productType dist:", types);
console.log("category distinct count:", Object.keys(cats).length, "top:", Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,8));
process.exit(0);
