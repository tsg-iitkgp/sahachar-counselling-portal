let meta={halls:[]}, chosen=null, verified=false, currentStep=1;
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
async function init(){
  const r=await fetch('api/meta'); meta=await r.json();
  const me=await fetch('api/student/me').then(x=>x.json());
  if(me.email){ verified=true; fillProfile(me.profile||{}); showStep(2); await loadBookings(); }
  const d=new Date(); d.setDate(d.getDate()+1); $('date').min=localISO(d);
  $('date').addEventListener('change',()=>refreshHalls()); $('hall').addEventListener('change',load);
  $('sendOtp').onclick=sendOtp; $('verifyOtp').onclick=verifyOtp; $('toAppointment').onclick=toAppointment;
  $('backToVerify').onclick=()=>showStep(1); $('backToDetails').onclick=()=>showStep(2);
  $('toConfirm').onclick=toConfirm; $('backToAppointment').onclick=()=>showStep(3); $('confirmBooking').onclick=book;
  refreshHalls();
}
function localISO(d){const x=new Date(d.getTime()-d.getTimezoneOffset()*60000);return x.toISOString().slice(0,10)}
function fillProfile(p){$('studentName').value=p.name||'';$('studentPhone').value=p.student_phone||'';$('rollNumber').value=p.roll_number||'';$('department').value=p.department||'';$('year').value=p.year||'';}
function showStep(n){currentStep=n;[1,2,3,4].forEach(i=>{const box=$('step'+i);if(box)box.classList.toggle('hidden',i!==n);const tag=document.querySelector(`.steps span[data-step="${i}"]`);if(tag)tag.classList.toggle('active',i===n)});window.scrollTo({top:0,behavior:'smooth'});}
async function sendOtp(){
 const email=$('studentEmail').value.trim().toLowerCase(); if(!email)return alert('Enter your institute email.');
 const r=await fetch('api/student/request-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}); const d=await r.json();
 if(!r.ok)return alert(d.error||'Unable to send OTP.'); $('otpBox').classList.remove('hidden'); $('otp').value=''; $('verifyMsg').textContent=d.devOtp ? `Development OTP: ${d.devOtp} (valid for 10 minutes).` : 'OTP sent to your email. It is valid for 10 minutes.'; $('otp').focus();
}
async function verifyOtp(){
 const email=$('studentEmail').value.trim().toLowerCase(), code=$('otp').value.trim(); if(code.length!==6)return alert('Enter the 6-digit OTP.');
 const r=await fetch('api/student/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,code,name:$('studentName').value.trim(),studentPhone:$('studentPhone').value.trim(),rollNumber:$('rollNumber').value.trim(),department:$('department').value.trim(),year:$('year').value.trim()})}); const d=await r.json();
 if(!r.ok)return alert(d.error||'Verification failed.'); verified=true; $('verifyMsg').textContent='Email verified successfully.'; await loadBookings(); showStep(2);
}
function toAppointment(){
 if(!$('studentName').value.trim()||!$('rollNumber').value.trim()||!$('studentPhone').value.trim())return alert('Please enter your name, 10-digit contact number and roll number.');
  if(!/^\d{10}$/.test($('studentPhone').value.trim()))return alert('Please enter a valid 10-digit contact number.');
 showStep(3); refreshHalls();
}
async function refreshHalls(){
 const date=$('date').value,select=$('hall'); const previous=select.value; select.innerHTML='<option value="">Select hall</option>'; chosen=null; $('toConfirm').disabled=true;
 if(!date){$('availability').textContent='Select a date to see halls with rostered counselling availability.';return;}
 const r=await fetch(`api/availability?date=${encodeURIComponent(date)}`),data=await r.json();
 const halls=[...new Set(data.slots.map(x=>x.hall))].sort((a,b)=>a.localeCompare(b)); halls.forEach(h=>{const o=document.createElement('option');o.value=h;o.textContent=h;select.appendChild(o)});
 if(halls.includes(previous))select.value=previous; else if(halls.length===1)select.value=halls[0];
 $('availability').textContent=halls.length?`${halls.length} hall${halls.length===1?'':'s'} have rostered availability on ${data.day}.`:`No counselling locations are rostered for ${data.day}.`;
 if(select.value)load();
}
async function load(){
 const date=$('date').value,hall=$('hall').value;if(!date||!hall)return;chosen=null;$('toConfirm').disabled=true;
 const r=await fetch(`api/availability?date=${encodeURIComponent(date)}&hall=${encodeURIComponent(hall)}`),data=await r.json(); const grouped={};data.slots.forEach(x=>(grouped[x.counsellor]??=[]).push(x));
 const box=$('availability');box.innerHTML='';
 Object.entries(grouped).forEach(([c,slots])=>{const div=document.createElement('div');div.className='counsellor';div.innerHTML=`<h3>${esc(c)}</h3><div class="slots"></div>`;const sdiv=div.querySelector('.slots');
  slots.forEach(s=>{const b=document.createElement('button');b.type='button';b.className='slot '+(s.available?'':'disabled');b.disabled=!s.available;b.textContent=`${s.start}–${s.end}`;b.onclick=()=>{document.querySelectorAll('.slot').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');chosen={counsellor:c,startTime:s.start,endTime:s.end};$('toConfirm').disabled=false};sdiv.appendChild(b)});box.appendChild(div)});
 if(!Object.keys(grouped).length)box.textContent='No counsellor is rostered at this hall on the selected date.';
}
function toConfirm(){if(!chosen)return alert('Please select an available 60-minute slot.');const date=new Date($('date').value+'T12:00:00');const nice=date.toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'});$('summary').innerHTML=`<div><span>Date</span><strong>${esc(nice)}</strong></div><div><span>Hall</span><strong>${esc($('hall').value)}</strong></div><div><span>Counsellor</span><strong>${esc(chosen.counsellor)}</strong></div><div><span>Time</span><strong>${esc(chosen.startTime)} – ${esc(chosen.endTime)}</strong></div>`;showStep(4);}
async function book(){
 if(!verified)return alert('Please verify your institute email first.'); if(!chosen)return alert('Please select an appointment slot.');
 const payload={studentName:$('studentName').value.trim(),studentEmail:$('studentEmail').value.trim().toLowerCase(),studentPhone:$('studentPhone').value.trim(),rollNumber:$('rollNumber').value.trim(),department:$('department').value.trim(),year:$('year').value.trim(),hall:$('hall').value,date:$('date').value,...chosen,reason:$('reason').value.trim()};
 const r=await fetch('api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok)return alert(d.error||'Booking failed.');
 $('result').innerHTML=`<div class="success"><strong>Appointment confirmed.</strong><br><span class="booking-id">${esc(d.bookingId)}</span><br>${esc(d.counsellor)} • ${esc(d.date)} • ${esc(d.time)}<br>${esc(d.hall)}<br><small>Confirmation has been sent to your institute email if email delivery is configured.</small></div>`;
 await loadBookings(); chosen=null; $('confirmBooking').disabled=true;
}
async function loadBookings(){
 if(!verified)return;const r=await fetch('api/bookings/me');if(!r.ok)return;const rows=await r.json();
 $('myBookings').innerHTML=rows.length?rows.map(b=>`<div class="booking-row"><b>${esc(b.booking_id)}</b><span>${esc(b.date)} ${esc(b.start_time)}</span><span>${esc(b.hall)}</span><span>${esc(b.counsellor)}</span><span class="${esc(b.status).toLowerCase()}">${esc(b.status)}</span>${b.status==='BOOKED'?`<button class="danger" onclick="cancelMine('${esc(b.booking_id)}')">Cancel</button>`:''}</div>`).join(''):'No bookings found.';
}
async function cancelMine(id){if(!confirm('Cancel this appointment?'))return;const r=await fetch('api/student/bookings/'+encodeURIComponent(id)+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'Cancelled by student'})});if(!r.ok)return alert((await r.json()).error);loadBookings();}
init();
