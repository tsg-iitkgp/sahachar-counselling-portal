const XLSX = require("xlsx");

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 8500;
const INSTITUTE_EMAIL_DOMAINS = (process.env.INSTITUTE_EMAIL_DOMAINS || "iitkgp.ac.in").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
const ALLOWED_TEST_EMAILS = (process.env.ALLOWED_TEST_EMAILS || "").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
const ROOT = __dirname;
const roster = JSON.parse(fs.readFileSync(path.join(ROOT,"data/roster.json")));
const rosterMasterHash = crypto.createHash("sha256").update(JSON.stringify(roster)).digest("hex");
const contacts = JSON.parse(fs.readFileSync(path.join(ROOT,"data/contacts.json")));
const counsellorAliases = {
  "Anindita":"Anindita Chakraborty",
  "Azwar":"Azwar Kamal",
  "Pallabi":"Pallabi Sen",
  "Sanjeevani":"Sanjeevanee Mukhopadhyay",
  "Sreyoshi":"Sreyoshi Ghosh",
  "Titasa":"Titasa Ray"
};
function contactFor(name){ return contacts[name] || contacts[counsellorAliases[name]] || {}; }
function canonicalCounsellor(name){ return contacts[name] ? name : (counsellorAliases[name] || name); }
function counsellorEmailFor(name){
  const canonical = canonicalCounsellor(String(name||"").trim());
  const fromContacts = contacts[canonical]?.email || contacts[String(name||"").trim()]?.email;
  if(fromContacts) return fromContacts;
  const row = db.prepare("SELECT email FROM counsellors WHERE name=? AND active=1").get(canonical);
  return row?.email || "";
}

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-secret",
  resave:false, saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:1000*60*60*8}
}));
app.use(express.static(path.join(ROOT,"public")));

const db = new Database(path.join(ROOT,"data/sahachar.db"));

function seedConfiguration(){
 const hc=db.prepare("SELECT COUNT(*) c FROM halls").get().c;
 if(!hc){
   const ih=db.prepare("INSERT OR IGNORE INTO halls(name) VALUES(?)");
   [...new Set(roster.map(x=>x.hall))].forEach(h=>ih.run(h));
   ih.run("VSRC-2");
 }
 const cc=db.prepare("SELECT COUNT(*) c FROM counsellors").get().c;
 if(!cc){
   const ic=db.prepare("INSERT OR IGNORE INTO counsellors(name,email,phone) VALUES(?,?,?)");
   Object.entries(contacts).forEach(([name,c])=>ic.run(name,c.email,c.phone||""));
 }
 const rc=db.prepare("SELECT COUNT(*) c FROM roster_assignments").get().c;
 if(!rc){
   const ir=db.prepare("INSERT OR IGNORE INTO roster_assignments(day,hall,counsellor,window) VALUES(?,?,?,?)");
   roster.forEach(x=>ir.run(x.day,x.hall,canonicalCounsellor(x.counsellor),x.window));
 }
}

db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS bookings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 booking_id TEXT UNIQUE NOT NULL,
 student_name TEXT NOT NULL,
 student_email TEXT NOT NULL,
 student_phone TEXT,
 roll_number TEXT NOT NULL,
 department TEXT,
 year TEXT,
 hall TEXT NOT NULL,
 counsellor TEXT NOT NULL,
 date TEXT NOT NULL,
 day TEXT NOT NULL,
 start_time TEXT NOT NULL,
 end_time TEXT NOT NULL,
 reason TEXT,
 status TEXT NOT NULL DEFAULT 'BOOKED',
 cancellation_reason TEXT,
 cancelled_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_slot
ON bookings(date,hall,counsellor,start_time)
WHERE status='BOOKED';
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 counsellor_email TEXT NOT NULL,
 booking_id TEXT NOT NULL,
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 read INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS halls (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT UNIQUE NOT NULL,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS counsellors (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT UNIQUE NOT NULL,
 email TEXT UNIQUE NOT NULL,
 phone TEXT,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS roster_assignments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 day TEXT NOT NULL,
 hall TEXT NOT NULL,
 counsellor TEXT NOT NULL,
 window TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 UNIQUE(day,hall,counsellor,window)
);
CREATE TABLE IF NOT EXISTS blocked_slots (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 date TEXT NOT NULL,
 hall TEXT NOT NULL,
 counsellor TEXT NOT NULL,
 start_time TEXT NOT NULL,
 reason TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(date,hall,counsellor,start_time)
);
CREATE TABLE IF NOT EXISTS otps (
 email TEXT PRIMARY KEY,
 code TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS student_profiles (
 email TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 student_phone TEXT,
 roll_number TEXT,
 department TEXT,
 year TEXT,
 verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_type TEXT NOT NULL,
 actor_email TEXT,
 action TEXT NOT NULL,
 target_id TEXT,
 details TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS system_meta (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
`);

// Counsellor operational workflow fields. Existing databases are upgraded safely.
for (const stmt of [
  "ALTER TABLE bookings ADD COLUMN checked_in_at TEXT",
  "ALTER TABLE bookings ADD COLUMN started_at TEXT",
  "ALTER TABLE bookings ADD COLUMN completed_at TEXT",
  "ALTER TABLE bookings ADD COLUMN status_updated_at TEXT",
  "ALTER TABLE bookings ADD COLUMN status_updated_by TEXT",
  "ALTER TABLE bookings ADD COLUMN student_phone TEXT"
]) {
  try { db.exec(stmt); } catch (e) { if (!String(e.message||e).includes("duplicate column name")) throw e; }
}

try { db.exec("ALTER TABLE student_profiles ADD COLUMN student_phone TEXT"); } catch (e) { if (!String(e.message||e).includes("duplicate column name")) throw e; }

seedConfiguration();

function rosterKey(x){ return [x.day,x.hall,canonicalCounsellor(x.counsellor),x.window].join("|"); }
function ensureMasterRoster(){
  const imported=db.prepare("SELECT value FROM system_meta WHERE key='master_roster_hash'").get();
  const active=db.prepare("SELECT day,hall,counsellor,window FROM roster_assignments WHERE active=1").all().map(rosterKey).sort();
  const expected=roster.map(rosterKey).sort();
  const matches=active.length===expected.length && active.every((v,i)=>v===expected[i]);
  if(!imported || !matches){
    const tx=db.transaction(()=>{
      db.prepare("DELETE FROM roster_assignments").run();
      const ir=db.prepare("INSERT INTO roster_assignments(day,hall,counsellor,window,active) VALUES(?,?,?,?,1)");
      roster.forEach(x=>ir.run(x.day,x.hall,canonicalCounsellor(x.counsellor),x.window));
      db.prepare("INSERT INTO system_meta(key,value) VALUES('master_roster_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(rosterMasterHash);
    });
    tx();
    console.log(`[SAHACHAR] Master roster synchronized: ${roster.length} assignments.`);
  }
}
ensureMasterRoster();

const transporter = (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
 ? nodemailer.createTransport({
    host:process.env.SMTP_HOST, port:Number(process.env.SMTP_PORT||587),
    secure:String(process.env.SMTP_SECURE||"false")==="true",
    auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}
   }) : null;

function dayName(date){
  return new Intl.DateTimeFormat("en-IN",{weekday:"long",timeZone:"Asia/Kolkata"}).format(new Date(date+"T12:00:00+05:30"));
}
function parseWindow(window){
  const [a,b]=window.split(" - ");
  function h(x){
    const [n,ampm]=x.split(" ");
    let v=Number(n); if(ampm==="AM" && v===12)v=0; if(ampm==="PM" && v!==12)v+=12; return v;
  }
  return [h(a),h(b)];
}
function slotsFor(window){
  let [start,end]=parseWindow(window);
  // 8 PM - 12 AM crosses midnight; treat 12 AM as hour 24 so four
  // evening slots are generated. The 1 AM - 5 AM window is already
  // entirely inside the following calendar day.
  if(end<=start) end+=24;
  const out=[];
  for(let h=start;h<end;h++){
    const fmt=x=>{
      const hour=((x%24)+24)%24;
      const ap=hour<12?"AM":"PM";
      const n=hour%12||12;
      return `${String(n).padStart(2,"0")}:00 ${ap}`;
    };
    out.push({start:fmt(h),end:fmt(h+1)});
  }
  return out;
}
const WEEKDAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
function rosterBookingDay(rosterDay,window){
  // The Excel roster labels the overnight 1 AM - 5 AM duty by the
  // evening/day it follows. Therefore Wednesday 1 AM - 5 AM is booked
  // against Thursday, Thursday 1 AM - 5 AM against Friday, etc.
  if(window!=="1 AM - 5 AM") return rosterDay;
  const i=WEEKDAYS.indexOf(rosterDay);
  return i===-1 ? rosterDay : WEEKDAYS[(i+1)%7];
}
function currentRoster(){
  const n=db.prepare("SELECT COUNT(*) c FROM roster_assignments WHERE active=1").get().c;
  if(n) return db.prepare("SELECT day,hall,counsellor,window FROM roster_assignments WHERE active=1").all();
  return roster;
}
function availability(date,hall){
  const day=dayName(date);
  return currentRoster()
    .filter(r=>rosterBookingDay(r.day,r.window)===day && (!hall || r.hall===hall))
    .flatMap(r=>{
      const c=contactFor(r.counsellor);
      return slotsFor(r.window).map(s=>{
        const booked=db.prepare("SELECT booking_id FROM bookings WHERE date=? AND hall=? AND counsellor=? AND start_time=? AND status='BOOKED'")
          .get(date,r.hall,r.counsellor,s.start);
        const blocked=db.prepare("SELECT id FROM blocked_slots WHERE date=? AND hall=? AND counsellor=? AND start_time=?")
          .get(date,r.hall,r.counsellor,s.start);
        return {
          ...r,
          rosterDay:r.day,
          bookingDay:day,
          ...s,
          email:c.email,
          available:!booked&&!blocked,
          blocked:!!blocked
        };
      });
    });
}
function authAdmin(req,res,next){
  if(req.session.admin) return next();
  res.status(401).json({error:"Admin authentication required"});
}
function authCounsellor(req,res,next){
  if(req.session.counsellorEmail) return next();
  res.status(401).json({error:"Counsellor authentication required"});
}

function isInstituteEmail(email){
  const e=String(email||"").trim().toLowerCase();
  if(ALLOWED_TEST_EMAILS.includes(e)) return true;
  return INSTITUTE_EMAIL_DOMAINS.some(d=>e.endsWith("@"+d) || e.endsWith(d) && e.includes("@"));
}
function audit(actorType,actorEmail,action,targetId,details){
  db.prepare("INSERT INTO audit_log(actor_type,actor_email,action,target_id,details) VALUES(?,?,?,?,?)")
    .run(actorType,actorEmail||"",action,targetId||"",details||"");
}
async function sendMail(to,subject,text){
  if(!to){
    console.warn("[SAHACHAR MAIL] Skipped: recipient email is missing.",{subject});
    return false;
  }

  if(process.env.RESEND_API_KEY){
    try{
      const response = await fetch("https://api.resend.com/emails",{
        method:"POST",
        headers:{
          "Authorization":`Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          from:process.env.RESEND_FROM||process.env.MAIL_FROM||"SAHACHAR <onboarding@resend.dev>",
          to:[to],
          subject,
          text
        })
      });

      const data = await response.json().catch(()=>({}));

      if(!response.ok){
        throw new Error(`Resend ${response.status}: ${JSON.stringify(data)}`);
      }

      console.log(`[SAHACHAR MAIL] Sent via Resend: ${subject} -> ${to} (${data.id||"accepted"})`);
      return true;
    }catch(e){
      console.error(`[SAHACHAR MAIL] Resend failed: ${subject} -> ${to}`,e);
      throw e;
    }
  }

  if(!transporter){
    console.warn("[SAHACHAR MAIL] Not sent: SMTP is not configured.",{to,subject});
    return false;
  }

  try{
    const info = await transporter.sendMail({
      from:process.env.MAIL_FROM||process.env.SMTP_USER,
      to,
      subject,
      text
    });
    console.log(`[SAHACHAR MAIL] Sent via SMTP: ${subject} -> ${to} (${info.messageId||"accepted"})`);
    return true;
  }catch(e){
    console.error(`[SAHACHAR MAIL] SMTP failed: ${subject} -> ${to}`,e);
    throw e;
  }
}

app.get("/api/meta",(req,res)=>{
  const halls=db.prepare("SELECT name FROM halls WHERE active=1 ORDER BY name").all().map(x=>x.name);
  const counsellors=db.prepare("SELECT name,email FROM counsellors WHERE active=1 ORDER BY name").all();
  res.json({halls,counsellors,sessionMinutes:60,windows:["8 PM - 12 AM","1 AM - 5 AM"]});
});

app.get("/api/availability",(req,res)=>{
  const {date,hall}=req.query;
  if(!date) return res.status(400).json({error:"date is required"});
  res.json({date,day:dayName(date),slots:availability(date,hall||null)});
});

app.post("/api/bookings",async(req,res)=>{
  const sessionEmail=String(req.session.studentEmail||"").trim().toLowerCase();
  const {studentName,studentEmail,studentPhone,rollNumber,department,year,hall,counsellor,date,startTime,reason}=req.body;
  if(!sessionEmail) return res.status(401).json({error:"Please verify your institute email before booking."});
  if(!studentName||!studentEmail||!studentPhone||!rollNumber||!hall||!counsellor||!date||!startTime)
    return res.status(400).json({error:"Please complete all required fields, including your 10-digit contact number."});
  if(!/^\d{10}$/.test(String(studentPhone).trim()))
    return res.status(400).json({error:"Please enter a valid 10-digit contact number."});
  if(String(studentEmail).trim().toLowerCase()!==sessionEmail) return res.status(403).json({error:"The verified email and booking email do not match."});
  if(!isInstituteEmail(studentEmail)) return res.status(403).json({error:"Bookings require an approved SAHACHAR email address."});
  const a=availability(date,hall).find(x=>x.counsellor===counsellor&&x.start===startTime);
  if(!a || !a.available) return res.status(409).json({error:"That slot is no longer available. Please select another slot."});
  const bookingId="SAH-"+new Date().getFullYear()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
  try{
    db.prepare(`INSERT INTO bookings
      (booking_id,student_name,student_email,student_phone,roll_number,department,year,hall,counsellor,date,day,start_time,end_time,reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(bookingId,studentName.trim(),studentEmail.trim(),String(studentPhone).trim(),rollNumber.trim(),department||"",year||"",hall,counsellor,date,a.day,a.start,a.end,reason||"");
  }catch(e){ return res.status(409).json({error:"This slot was just booked by someone else. Please choose another slot."}); }
  db.prepare(`INSERT INTO student_profiles(email,name,student_phone,roll_number,department,year)
     VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET
       name=excluded.name, student_phone=excluded.student_phone, roll_number=excluded.roll_number, department=excluded.department, year=excluded.year, verified_at=CURRENT_TIMESTAMP`)
     .run(studentEmail.trim().toLowerCase(),studentName.trim(),String(studentPhone).trim(),rollNumber.trim(),department||"",year||"");

  const email=counsellorEmailFor(counsellor);
  const subject=`SAHACHAR: New counselling appointment ${bookingId}`;
  const body=`A new SAHACHAR counselling appointment has been booked.\n\nBooking ID: ${bookingId}\nStudent: ${studentName}\nContact Number: ${studentPhone}\nRoll Number: ${rollNumber}\nDate: ${date} (${a.day})\nTime: ${a.start} - ${a.end}\nHall: ${hall}\n\nPlease check the SAHACHAR counsellor dashboard for details.`;
  if(email){
    db.prepare("INSERT INTO notifications(counsellor_email,booking_id,title,body) VALUES(?,?,?,?)")
      .run(email,bookingId,"New SAHACHAR booking",body);
    try{ await sendMail(email,subject,body); }
    catch(e){ console.error(`[SAHACHAR] Counsellor notification failed for ${bookingId}.`); }
  }else{
    console.warn(`[SAHACHAR] No counsellor email found for "${counsellor}" (booking ${bookingId}).`);
  }
  try{ await sendMail(studentEmail,`SAHACHAR booking confirmed: ${bookingId}`,
    `Your SAHACHAR counselling appointment is confirmed.\n\nBooking ID: ${bookingId}\nCounsellor: ${counsellor}\nDate: ${date}\nTime: ${a.start} - ${a.end}\nHall: ${hall}\n\nPlease reach the hall on time.`); }catch(e){ console.error(e); }
  audit("student",studentEmail,"BOOK",bookingId,JSON.stringify({hall,counsellor,date,startTime:a.start}));
  res.json({success:true,bookingId,counsellor,date,time:`${a.start} - ${a.end}`,hall});
});


app.post("/api/student/request-otp",async(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  if(!email || !email.includes("@")) return res.status(400).json({error:"Enter a valid institute email."});
  if(!isInstituteEmail(email)) return res.status(403).json({error:"Please use an approved SAHACHAR email address."});
  const code=String(crypto.randomInt(100000,999999));
  db.prepare("INSERT OR REPLACE INTO otps(email,code,expires_at) VALUES(?,?,?)").run(email,code,Date.now()+10*60*1000);
  try{await sendMail(email,"SAHACHAR student verification OTP",`Your SAHACHAR verification OTP is ${code}. It expires in 10 minutes.`);}
  catch(e){ if(!transporter && process.env.NODE_ENV !== "production") console.log(`[SAHACHAR DEV] Student OTP for ${email}: ${code}`); }
  const payload={success:true,message:"OTP generated successfully."};
  if(!transporter && process.env.NODE_ENV !== "production") payload.devOtp=code;
  res.json(payload);
});
app.post("/api/student/verify-otp",(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase(), code=String(req.body.code||"").trim();
  const x=db.prepare("SELECT * FROM otps WHERE email=?").get(email);
  if(!x || x.code!==code || Date.now()>x.expires_at)return res.status(401).json({error:"Invalid or expired OTP."});
  req.session.studentEmail=email;
  db.prepare("DELETE FROM otps WHERE email=?").run(email);
  db.prepare(`INSERT INTO student_profiles(email,name,student_phone,roll_number,department,year)
    VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET
      name=excluded.name, student_phone=excluded.student_phone, roll_number=excluded.roll_number, department=excluded.department, year=excluded.year, verified_at=CURRENT_TIMESTAMP`)
    .run(email, req.body.name||email.split("@")[0], req.body.studentPhone||"", req.body.rollNumber||"", req.body.department||"", req.body.year||"");
  audit("student",email,"LOGIN",email,"Student email OTP verified");
  res.json({success:true});
});
app.post("/api/student/logout",(req,res)=>{req.session.studentEmail=null;res.json({success:true})});
app.get("/api/student/me",(req,res)=>{
  if(!req.session.studentEmail)return res.json({email:null});
  const profile=db.prepare("SELECT * FROM student_profiles WHERE email=?").get(req.session.studentEmail);
  res.json({email:req.session.studentEmail,profile});
});

app.post("/api/student/bookings/:id/cancel",async(req,res)=>{
  const email=req.session.studentEmail;
  if(!email)return res.status(401).json({error:"Student verification required."});
  const b=db.prepare("SELECT * FROM bookings WHERE booking_id=? AND student_email=?").get(req.params.id,email);
  if(!b)return res.status(404).json({error:"Booking not found."});
  if(b.status!=="BOOKED")return res.status(400).json({error:"This booking is already cancelled."});
  db.prepare("UPDATE bookings SET status='CANCELLED', cancellation_reason=?, cancelled_at=CURRENT_TIMESTAMP WHERE booking_id=?")
    .run(req.body.reason||"Cancelled by student",b.booking_id);
  audit("student",email,"CANCEL",b.booking_id,req.body.reason||"Cancelled by student");
  try{await sendMail(counsellorEmailFor(b.counsellor),`SAHACHAR appointment cancelled: ${b.booking_id}`,
    `Booking ${b.booking_id} has been cancelled by the student.\nDate: ${b.date}\nTime: ${b.start_time} - ${b.end_time}\nHall: ${b.hall}`);}catch(e){}
  res.json({success:true});
});
app.post("/api/student/bookings/:id/reschedule",async(req,res)=>{
  const email=req.session.studentEmail;
  if(!email)return res.status(401).json({error:"Student verification required."});
  const old=db.prepare("SELECT * FROM bookings WHERE booking_id=? AND student_email=? AND status='BOOKED'").get(req.params.id,email);
  if(!old)return res.status(404).json({error:"Active booking not found."});
  const {hall,counsellor,date,startTime}=req.body;
  const a=availability(date,hall).find(x=>x.counsellor===counsellor&&x.start===startTime);
  if(!a || !a.available)return res.status(409).json({error:"The new slot is not available."});
  const newId="SAH-"+new Date().getFullYear()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
  const tx=db.transaction(()=>{
    db.prepare("UPDATE bookings SET status='CANCELLED', cancellation_reason=?, cancelled_at=CURRENT_TIMESTAMP WHERE booking_id=?")
      .run("Rescheduled by student",old.booking_id);
    db.prepare(`INSERT INTO bookings
      (booking_id,student_name,student_email,student_phone,roll_number,department,year,hall,counsellor,date,day,start_time,end_time,reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newId,old.student_name,old.student_email,old.student_phone,old.roll_number,old.department,old.year,hall,counsellor,date,a.day,a.start,a.end,old.reason||"");
  });
  try{tx()}catch(e){return res.status(409).json({error:"The new slot could not be booked. Please try again."})}
  const email2=counsellorEmailFor(counsellor);
  if(email2)try{await sendMail(email2,`SAHACHAR new appointment after rescheduling: ${newId}`,
    `A student has rescheduled a counselling appointment.\nBooking ID: ${newId}\nStudent: ${old.student_name}\nDate: ${date} (${a.day})\nTime: ${a.start} - ${a.end}\nHall: ${hall}`);}catch(e){}
  try{await sendMail(email,`SAHACHAR appointment rescheduled: ${newId}`,
    `Your appointment has been rescheduled.\nNew Booking ID: ${newId}\nCounsellor: ${counsellor}\nDate: ${date}\nTime: ${a.start} - ${a.end}\nHall: ${hall}`);}catch(e){}
  res.json({success:true,bookingId:newId});
});
app.get("/api/bookings/me",(req,res)=>{
  const email=String(req.session.studentEmail||"").trim().toLowerCase();
  if(!email)return res.status(401).json({error:"Student verification required."});
  res.json(db.prepare("SELECT booking_id,student_name,student_email,roll_number,hall,counsellor,date,day,start_time,end_time,status,created_at FROM bookings WHERE student_email=? ORDER BY date,start_time DESC").all(email));
});

app.post("/api/counsellor/request-otp",async(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const name=Object.keys(contacts).find(n=>contacts[n].email.toLowerCase()===email);
  if(!name)return res.status(404).json({error:"This email is not registered as a SAHACHAR counsellor."});
  const code=String(crypto.randomInt(100000,999999));
  db.prepare("INSERT OR REPLACE INTO otps(email,code,expires_at) VALUES(?,?,?)").run(email,code,Date.now()+10*60*1000);
  try{await sendMail(email,"SAHACHAR counsellor login OTP",`Your SAHACHAR dashboard OTP is ${code}. It expires in 10 minutes.`);}
  catch(e){ if(!transporter && process.env.NODE_ENV !== "production") console.log(`[SAHACHAR DEV] Counsellor OTP for ${email}: ${code}`); }
  if(!transporter && process.env.NODE_ENV !== "production") console.log(`[SAHACHAR DEV] Counsellor OTP for ${email}: ${code}`);
  res.json({success:true,message:"OTP sent to your registered email."});
});
app.post("/api/counsellor/verify-otp",(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase(), code=String(req.body.code||"").trim();
  const x=db.prepare("SELECT * FROM otps WHERE email=?").get(email);
  if(!x || x.code!==code || Date.now()>x.expires_at)return res.status(401).json({error:"Invalid or expired OTP."});
  req.session.counsellorEmail=email;
  db.prepare("DELETE FROM otps WHERE email=?").run(email);
  res.json({success:true});
});
app.post("/api/counsellor/logout",(req,res)=>{req.session.counsellorEmail=null;res.json({success:true})});
app.get("/api/counsellor/me",authCounsellor,(req,res)=>{
  const name=Object.keys(contacts).find(n=>contacts[n].email.toLowerCase()===req.session.counsellorEmail);
  res.json({name,email:req.session.counsellorEmail});
});
app.get("/api/counsellor/bookings",authCounsellor,(req,res)=>{
  const email=req.session.counsellorEmail;
  const canonical=Object.keys(contacts).find(n=>contacts[n].email.toLowerCase()===email) || "";
  const rosterNames=Object.entries(counsellorAliases).filter(([k,v])=>v===canonical).map(([k])=>k).concat([canonical]).filter(Boolean);
  const date=String(req.query.date||"").trim();
  const range=String(req.query.range||"").trim();
  let where=`student_email IS NOT NULL AND counsellor IN (${rosterNames.map(()=>"?").join(",")})`;
  const args=[...rosterNames];
  if(date){ where += " AND date=?"; args.push(date); }
  else if(range==="upcoming"){
    const today=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Kolkata"});
    where += " AND date>=?"; args.push(today);
  }
  const rows=db.prepare(`SELECT * FROM bookings WHERE ${where} ORDER BY date,start_time`).all(...args);
  res.json(rows);
});

app.get("/api/counsellor/summary",authCounsellor,(req,res)=>{
  const email=req.session.counsellorEmail;
  const canonical=Object.keys(contacts).find(n=>contacts[n].email.toLowerCase()===email) || "";
  const names=Object.entries(counsellorAliases).filter(([k,v])=>v===canonical).map(([k])=>k).concat([canonical]).filter(Boolean);
  const ph=names.map(()=>"?").join(",");
  const today=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Kolkata"});
  const base=`student_email IS NOT NULL AND counsellor IN (${ph})`;
  const count=(extra,args)=>db.prepare(`SELECT COUNT(*) c FROM bookings WHERE ${base} ${extra}`).get(...names,...args).c;
  res.json({today:count(" AND date=?",[today]), upcoming:count(" AND date>=? AND status IN ('BOOKED','CHECKED_IN','IN_SESSION')",[today]), completedToday:count(" AND date=? AND status='COMPLETED'",[today]), noShowToday:count(" AND date=? AND status='NO_SHOW'",[today])});
});

app.patch("/api/counsellor/bookings/:id/status",authCounsellor,(req,res)=>{
  const allowed=new Set(["CHECKED_IN","IN_SESSION","COMPLETED","NO_SHOW"]);
  const next=String(req.body.status||"").trim().toUpperCase();
  if(!allowed.has(next)) return res.status(400).json({error:"Invalid session status."});
  const email=req.session.counsellorEmail;
  const canonical=Object.keys(contacts).find(n=>contacts[n].email.toLowerCase()===email) || "";
  const names=Object.entries(counsellorAliases).filter(([k,v])=>v===canonical).map(([k])=>k).concat([canonical]).filter(Boolean);
  const ph=names.map(()=>"?").join(",");
  const b=db.prepare(`SELECT * FROM bookings WHERE booking_id=? AND counsellor IN (${ph})`).get(req.params.id,...names);
  if(!b) return res.status(404).json({error:"Appointment not found for this counsellor."});
  if(["CANCELLED"].includes(b.status)) return res.status(400).json({error:"Cancelled appointments cannot be updated."});
  const now=new Date().toISOString();
  let sql="UPDATE bookings SET status=?, status_updated_at=?, status_updated_by=?";
  const vals=[next,now,email];
  if(next==="CHECKED_IN") sql += ", checked_in_at=COALESCE(checked_in_at,?)", vals.push(now);
  if(next==="IN_SESSION") sql += ", started_at=COALESCE(started_at,?)", vals.push(now);
  if(next==="COMPLETED") sql += ", completed_at=COALESCE(completed_at,?)", vals.push(now);
  sql += " WHERE booking_id=?"; vals.push(b.booking_id);
  db.prepare(sql).run(...vals);
  audit("counsellor",email,"STATUS_CHANGE",b.booking_id,JSON.stringify({from:b.status,to:next}));
  res.json({success:true,status:next});
});
app.get("/api/counsellor/notifications",authCounsellor,(req,res)=>{
  res.json(db.prepare("SELECT * FROM notifications WHERE counsellor_email=? ORDER BY id DESC LIMIT 50").all(req.session.counsellorEmail));
});
app.post("/api/counsellor/notifications/read",authCounsellor,(req,res)=>{
  db.prepare("UPDATE notifications SET read=1 WHERE counsellor_email=?").run(req.session.counsellorEmail); res.json({success:true});
});

app.post("/api/admin/login",(req,res)=>{
  const u=String(req.body.username||""), p=String(req.body.password||"");
  if(u===(process.env.ADMIN_USER||"admin") && p===(process.env.ADMIN_PASSWORD||"change-me")){
    req.session.admin=true; audit("admin","admin","LOGIN","","Admin login"); return res.json({success:true});
  }
  res.status(401).json({error:"Invalid admin credentials"});
});
app.post("/api/admin/logout",(req,res)=>{req.session.admin=null;res.json({success:true})});
app.get("/api/admin/dashboard",authAdmin,(req,res)=>{
  const total=db.prepare("SELECT COUNT(*) c FROM bookings").get().c;
  const active=db.prepare("SELECT COUNT(*) c FROM bookings WHERE status IN ('BOOKED','CHECKED_IN','IN_SESSION')").get().c;
  const cancelled=db.prepare("SELECT COUNT(*) c FROM bookings WHERE status='CANCELLED'").get().c;
  const noShows=db.prepare("SELECT COUNT(*) c FROM bookings WHERE status='NO_SHOW'").get().c;
  const today=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Kolkata"});
  const todayCount=db.prepare("SELECT COUNT(*) c FROM bookings WHERE date=? AND status IN ('BOOKED','CHECKED_IN','IN_SESSION')").get(today).c;
  const completedToday=db.prepare("SELECT COUNT(*) c FROM bookings WHERE date=? AND status='COMPLETED'").get(today).c;
  const upcoming=db.prepare("SELECT * FROM bookings WHERE status IN ('BOOKED','CHECKED_IN','IN_SESSION') AND date>=? ORDER BY date,start_time LIMIT 8").all(today);
  res.json({total,active,cancelled,noShows,todayCount,completedToday,upcoming});
});
app.get("/api/admin/bookings",authAdmin,(req,res)=>{
  res.json(db.prepare("SELECT * FROM bookings ORDER BY date DESC,start_time DESC LIMIT 1000").all());
});
app.post("/api/admin/bookings/:id/cancel",authAdmin,async(req,res)=>{
  const b=db.prepare("SELECT * FROM bookings WHERE booking_id=?").get(req.params.id);
  if(!b)return res.status(404).json({error:"Booking not found"});
  db.prepare("UPDATE bookings SET status='CANCELLED' WHERE booking_id=?").run(req.params.id);
  audit("admin","admin","CANCEL",b.booking_id,"Cancelled by admin");
  try{await sendMail(b.student_email,`SAHACHAR appointment cancelled: ${b.booking_id}`,`Your appointment ${b.booking_id} on ${b.date} at ${b.start_time} has been cancelled. Please book another available slot.`);}catch(e){}
  res.json({success:true});
});

function reportFilters(req){
  const {from,to,counsellor,hall,status}=req.query;
  const where=[]; const args=[];
  if(from){where.push("date>=?");args.push(from)}
  if(to){where.push("date<=?");args.push(to)}
  if(counsellor){where.push("counsellor=?");args.push(counsellor)}
  if(hall){where.push("hall=?");args.push(hall)}
  if(status){where.push("status=?");args.push(status)}
  return {where:where.length?"WHERE "+where.join(" AND "):"",args};
}

app.get("/api/admin/report",(req,res)=>{
  if(!req.session.admin)return res.status(401).json({error:"Admin authentication required"});
  const f=reportFilters(req);
  const byCounsellor=db.prepare(`SELECT counsellor, COUNT(*) count FROM bookings ${f.where} GROUP BY counsellor ORDER BY count DESC`).all(...f.args);
  const byHall=db.prepare(`SELECT hall, COUNT(*) count FROM bookings ${f.where} GROUP BY hall ORDER BY count DESC`).all(...f.args);
  const byDay=db.prepare(`SELECT day, COUNT(*) count FROM bookings ${f.where} GROUP BY day ORDER BY count DESC`).all(...f.args);
  const total=db.prepare(`SELECT COUNT(*) count FROM bookings ${f.where}`).get(...f.args).count;
  res.json({byCounsellor,byHall,byDay,total});
});

app.get("/api/admin/report/export",(req,res)=>{
  if(!req.session.admin)return res.status(401).json({error:"Admin authentication required"});
  const f=reportFilters(req);
  const rows=db.prepare(`SELECT booking_id,student_name,student_phone,student_email,roll_number,department,year,hall,counsellor,date,day,start_time,end_time,status,created_at,checked_in_at,started_at,completed_at,status_updated_at,status_updated_by FROM bookings ${f.where} ORDER BY date DESC,start_time DESC`).all(...f.args);
  const data=rows.map(b=>({
    "Booking ID":b.booking_id,"Student Name":b.student_name,"Contact Number":b.student_phone||"","Student Email":b.student_email,"Roll Number":b.roll_number,"Department":b.department||"","Year":b.year||"","Hall":b.hall,"Counsellor":b.counsellor,"Date":b.date,"Day":b.day,"Start Time":b.start_time,"End Time":b.end_time,"Status":b.status,"Created At":b.created_at||"","Checked In At":b.checked_in_at||"","Started At":b.started_at||"","Completed At":b.completed_at||"","Status Updated At":b.status_updated_at||"","Status Updated By":b.status_updated_by||""
  }));
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.json_to_sheet(data);
  ws['!cols']=[{wch:20},{wch:24},{wch:16},{wch:30},{wch:16},{wch:18},{wch:8},{wch:28},{wch:24},{wch:12},{wch:12},{wch:12},{wch:12},{wch:14},{wch:22},{wch:24},{wch:24},{wch:24},{wch:24},{wch:24}];
  XLSX.utils.book_append_sheet(wb,ws,"Bookings");
  const summary=[
    ["SAHACHAR Booking Report"],
    ["Generated",new Date().toISOString()],
    ["From",req.query.from||"All"],["To",req.query.to||"All"],["Counsellor",req.query.counsellor||"All"],["Hall",req.query.hall||"All"],["Status",req.query.status||"All"],
    [],["Total Records",rows.length]
  ];
  const sws=XLSX.utils.aoa_to_sheet(summary);
  sws['!cols']=[{wch:24},{wch:40}];
  XLSX.utils.book_append_sheet(wb,sws,"Summary");
  const buffer=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});
  const stamp=new Date().toISOString().slice(0,10);
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="SAHACHAR_Report_${stamp}.xlsx"`);
  res.send(buffer);
});

app.get("/api/admin/audit",authAdmin,(req,res)=>{
  res.json(db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 500").all());
});
app.get("/api/admin/config",authAdmin,(req,res)=>{
  res.json({
    halls:db.prepare("SELECT * FROM halls ORDER BY name").all(),
    counsellors:db.prepare("SELECT * FROM counsellors ORDER BY name").all(),
    roster:db.prepare("SELECT * FROM roster_assignments ORDER BY day,hall").all(),
    blocked:db.prepare("SELECT * FROM blocked_slots ORDER BY date,start_time").all()
  });
});
app.post("/api/admin/halls",authAdmin,(req,res)=>{
  const name=String(req.body.name||"").trim();
  if(!name)return res.status(400).json({error:"Hall name required"});
  try{db.prepare("INSERT INTO halls(name) VALUES(?)").run(name);res.json({success:true})}
  catch(e){res.status(409).json({error:"Hall already exists"})}
});
app.patch("/api/admin/halls/:id",authAdmin,(req,res)=>{
  const active=req.body.active?1:0;
  db.prepare("UPDATE halls SET active=? WHERE id=?").run(active,req.params.id);res.json({success:true});
});
app.post("/api/admin/counsellors",authAdmin,(req,res)=>{
  const name=String(req.body.name||"").trim(),email=String(req.body.email||"").trim(),phone=String(req.body.phone||"").trim();
  if(!name||!email)return res.status(400).json({error:"Name and email required"});
  try{db.prepare("INSERT INTO counsellors(name,email,phone) VALUES(?,?,?)").run(name,email,phone);res.json({success:true})}
  catch(e){res.status(409).json({error:"Counsellor already exists"})}
});
app.patch("/api/admin/counsellors/:id",authAdmin,(req,res)=>{
  db.prepare("UPDATE counsellors SET active=? WHERE id=?").run(req.body.active?1:0,req.params.id);res.json({success:true});
});
app.post("/api/admin/roster",authAdmin,(req,res)=>{
  const {day,hall,counsellor,window}=req.body;
  if(!day||!hall||!counsellor||!window)return res.status(400).json({error:"All roster fields required"});
  try{db.prepare("INSERT INTO roster_assignments(day,hall,counsellor,window) VALUES(?,?,?,?)").run(day,hall,counsellor,window);res.json({success:true})}
  catch(e){res.status(409).json({error:"This roster assignment already exists"})}
});
app.delete("/api/admin/roster/:id",authAdmin,(req,res)=>{
  db.prepare("UPDATE roster_assignments SET active=0 WHERE id=?").run(req.params.id);res.json({success:true});
});
app.post("/api/admin/block-slot",authAdmin,(req,res)=>{
  const {date,hall,counsellor,startTime,reason}=req.body;
  if(!date||!hall||!counsellor||!startTime)return res.status(400).json({error:"Date, hall, counsellor and start time required"});
  try{db.prepare("INSERT INTO blocked_slots(date,hall,counsellor,start_time,reason) VALUES(?,?,?,?,?)").run(date,hall,counsellor,startTime,reason||"Blocked by admin");res.json({success:true})}
  catch(e){res.status(409).json({error:"Slot already blocked"})}
});
app.delete("/api/admin/block-slot/:id",authAdmin,(req,res)=>{
  db.prepare("DELETE FROM blocked_slots WHERE id=?").run(req.params.id);res.json({success:true});
});
app.get("/api/admin/roster",authAdmin,(req,res)=>res.json(db.prepare("SELECT * FROM roster_assignments WHERE active=1 ORDER BY CASE day WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 WHEN 'Sunday' THEN 7 END,hall").all()));
app.post("/api/admin/roster/reset-master",authAdmin,(req,res)=>{
  const tx=db.transaction(()=>{
    db.prepare("DELETE FROM roster_assignments").run();
    const ir=db.prepare("INSERT INTO roster_assignments(day,hall,counsellor,window,active) VALUES(?,?,?,?,1)");
    roster.forEach(x=>ir.run(x.day,x.hall,canonicalCounsellor(x.counsellor),x.window));
    db.prepare("INSERT INTO system_meta(key,value) VALUES('master_roster_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(rosterMasterHash);
  });
  tx();
  audit("admin",req.session.admin,"RESET_MASTER_ROSTER","",`Restored ${roster.length} master roster assignments`);
  res.json({success:true,assignments:roster.length});
});

app.listen(PORT,()=>console.log(`SAHACHAR portal running on http://localhost:${PORT}`));
