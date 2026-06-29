import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, get, ref } from "firebase/database";
import { computeDemand } from "/Users/junidmohammed/Documents/marathon-ai/src/lib/demand.js";
import { distributeOrder, groupBySections } from "/Users/junidmohammed/Documents/marathon-ai/src/lib/allocate.js";
const app = initializeApp({apiKey:"AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo",authDomain:"marathon-club.firebaseapp.com",databaseURL:"https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",projectId:"marathon-club",storageBucket:"marathon-club.firebasestorage.app",messagingSenderId:"306270814317",appId:"1:306270814317:web:470395933121de7dbdbf64"});
await signInAnonymously(getAuth(app));
const db = getDatabase(app);
const [p,l,r] = await Promise.all([get(ref(db,"products")),get(ref(db,"insights_log")),get(ref(db,"returns_log"))]);
const d = computeDemand({ products:p.val()||{}, logs:l.val()||{}, returns:r.val()||{}, nowMs:Date.now(), window:"all" });
const res = distributeOrder({ rows: d.rows, total: 5000 });
const sections = groupBySections(res.allocations);
const out=[];
out.push(`order total requested=5000 allocated=${res.totalAllocated} (exact=${res.totalAllocated===5000})`);
let grand=0;
for (const s of sections){ grand+=s.subtotal; out.push(`  ${s.label.padEnd(9)} products=${String(s.allocations.length).padStart(4)} pairs=${String(s.subtotal).padStart(5)} cols=[${s.sizes.map(x=>x.replace(/_/g,".")).join(",")}]`); }
out.push(`  section subtotals sum = ${grand} (matches=${grand===res.totalAllocated})`);
console.log(out.join("\n"));
