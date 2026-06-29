import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, get, ref } from "firebase/database";
const app = initializeApp({apiKey:"AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo",authDomain:"marathon-club.firebaseapp.com",databaseURL:"https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",projectId:"marathon-club",storageBucket:"marathon-club.firebasestorage.app",messagingSenderId:"306270814317",appId:"1:306270814317:web:470395933121de7dbdbf64"});
try { await signInAnonymously(getAuth(app)); } catch(e){ console.log("anon auth failed:", e.message); }
const db = getDatabase(app);
let snap;
try { snap = await get(ref(db,"stock")); }
catch(e){ console.log("READ /stock DENIED:", e.message); process.exit(0); }
const stock = snap.val();
if(!stock){ console.log("/stock is EMPTY or unreadable (null)"); process.exit(0); }
console.log("Locations under /stock:", Object.keys(stock).join(", "));
console.log("");
for(const loc of Object.keys(stock)){
  const byProduct = stock[loc]||{};
  let cells=0, totalQty=0; const states={}; let nonZero=0;
  for(const pid of Object.keys(byProduct)){
    const bySize = byProduct[pid]||{};
    for(const sz of Object.keys(bySize)){
      const c = bySize[sz]||{};
      cells++;
      const q = typeof c.qty==="number"?c.qty:0;
      totalQty += q;
      if(q!==0) nonZero++;
      const st = c.state||"(unset)";
      states[st]=(states[st]||0)+1;
    }
  }
  console.log(`${loc.padEnd(15)} products=${String(Object.keys(byProduct).length).padStart(4)}  cells=${String(cells).padStart(5)}  nonZeroCells=${String(nonZero).padStart(5)}  totalQty=${String(totalQty).padStart(6)}  states=${JSON.stringify(states)}`);
}
process.exit(0);
