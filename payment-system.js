/* IJAZ WEAR payment module: manual bKash/Nagad claims, admin verification, manual orders, and order merging. */
(function () {
  "use strict";
  const money = n => "৳" + Number(n || 0).toLocaleString("en-IN");
  const clean = s => String(s || "").trim();
  const methodKey = s => String(s || "").toLowerCase().includes("nagad") ? "nagad" : "bkash";
  const methodName = s => methodKey(s) === "nagad" ? "Nagad" : "bKash";
  const methods = () => ["bKash","Nagad"].map(n => {
    const old = (db.set.pmeth || []).find(x => String(x.n).toLowerCase() === n.toLowerCase()) || {};
    return { n:n, on:true, num:clean(old.num) };
  });
  const feeFor = district => {
    const v=clean(district).toLowerCase();
    return v==="inside" || v==="dhaka" ? Number(db.set.dhaka||0) : Number(db.set.out||0);
  };
  const quotePayment = (items,type,district) => {
    const sub=(items||[]).reduce((sum,i)=>sum+Number(pr(prod(i.id))||0)*Number(i.q||0),0);
    const fee=sub?feeFor(district):0;
    const disc=type==="full_advance"?Math.min(30,sub+fee):0;
    return {sub:sub,disc:disc,fee:fee,total:Math.max(0,sub+fee-disc)};
  };
  const dueNow = (q,type) => type==="full_advance"?q.total:q.fee;

  quote = function(items,type,district){ return quotePayment(items,type,district); };

  createOrder = function(items,c,type,key){
    const old=db.orders.find(o=>o.key===key);
    if(old)return {o:old,dup:true};
    for(const i of items){
      const p=prod(i.id);
      if(!p||!p.pub)throw new Error("Product unavailable");
      const qty=items.filter(x=>x.id==i.id).reduce((a,b)=>a+Number(b.q||0),0);
      if(qty>p.stock)throw new Error("Not enough stock for "+p.name);
    }
    const q=quotePayment(items,type,c.delivery_zone||c.district);
    items.forEach(i=>{prod(i.id).stock-=i.q;slog(i.id,-i.q,"order","customer");});
    const id=Date.now()+Math.floor(Math.random()*1000);
    const no=String((db.set.brand||"IJ").slice(0,2).toUpperCase())+String(id).slice(-8);
    const o={
      id:id,no:no,key:key,c:c,method:"manual_transfer",pm:c.payment_method,
      trx:clean(c.transaction_id),sender_number:clean(c.sender_number),
      amount_sent:Number(c.amount_sent||0),payment_type:type,pay:"pending",
      status:"pending_payment",sub:q.sub,disc:q.disc,fee:q.fee,total:q.total,
      adv:dueNow(q,type),paid_amount:0,remaining_amount:q.total,ts:Date.now(),
      src:"Website",cloudSaved:false,
      items:items.map(i=>({id:i.id,name:prod(i.id).name,opt:i.opt,price:pr(prod(i.id)),qty:i.q})),
      hist:[{to:"pending_payment",by:"customer",at:Date.now(),reason:"Payment claim submitted; awaiting manual verification."}],
      notes:[],mgr:""
    };
    db.orders.unshift(o);commit();return {o:o};
  };

  persistCustomerOrder = async function(o){
    if(!sbClient)throw new Error("The order server is unavailable. Please try again later.");
    const orderId=crypto.randomUUID();
    const src={"Website":"website","Manual":"manual","Phone call":"phone","Facebook":"facebook","WhatsApp":"whatsapp","Instagram":"instagram","Walk-in":"walk_in"};
    const trx=clean(o.trx||o.c.transaction_id);
    const payload={
      id:orderId,legacy_id:Number(o.id),customer_name:o.c.name||"Customer",phone:o.c.phone||"",
      address:o.c.address||"",district:o.c.district||null,thana:o.c.area||null,
      delivery_charge:Number(o.fee||0),subtotal:Number(o.sub||0),total:Number(o.total||0),
      payment_method:methodKey(o.pm||o.c.payment_method),transaction_id:trx,
      payment_status:"pending",status:"pending_payment",payment_type:o.payment_type,
      paid_amount:0,remaining_amount:Number(o.total||0),order_source:src[o.src]||"website",
      customer_note:o.cnote||o.c.cnote||null,legacy_data:o,
      created_at:new Date(o.ts||Date.now()).toISOString()
    };
    const ins=await sbClient.from("orders").insert(payload);
    if(ins.error){
      if(ins.error.code==="23505")throw new Error("This Transaction ID has already been used. Please check it and submit a new TrxID.");
      throw new Error(ins.error.message||"Could not save the order.");
    }
    const itemRows=(o.items||[]).map(i=>({
      order_id:orderId,product_id:null,product_name:i.name,quantity:Number(i.qty),
      unit_price:Number(i.price),selected_options:{option:i.opt||""}
    }));
    if(itemRows.length){
      const ir=await sbClient.from("order_items").insert(itemRows);
      if(ir.error)throw new Error(ir.error.message||"Could not save order items.");
    }
    const pr=await sbClient.from("payment_records").insert({
      order_id:orderId,transaction_id:trx,payment_method:methodKey(o.pm||o.c.payment_method),
      payment_type:o.payment_type==="full_advance"?"full_advance":"delivery_charge",
      amount:Number(o.amount_sent||0),status:"pending",sender_number:o.sender_number||null,
      submitted_by_phone:o.c.phone||null
    }).select("*").single();
    if(pr.error){
      if(pr.error.code==="23505")throw new Error("This Transaction ID has already been submitted and cannot be reused.");
      throw new Error("Order saved, but payment claim could not be recorded: "+pr.error.message);
    }
    o.cloudId=orderId;o.cloudSaved=true;o.paymentRecord=pr.data;
    if(sbSession)commit();
    return pr.data;
  };

  const accountRows = () => methods().map(m =>
    '<div class="row sp"><span><b>'+m.n+' · Send Money</b></span><b>'+(m.num?esc(m.num):'<span class="mut">Not configured</span>')+'</b></div>'
  ).join("");

  const checkoutView = () => {
    const items=lines();
    if(!items.length)return '<p class="mut">Your cart is empty. <a class="ac" href="#/shop">Continue shopping</a></p>';
    const a=quotePayment(items,"delivery_first","inside");
    const b=quotePayment(items,"full_advance","inside");
    return '<h2>Checkout</h2><p class="mut">Every order requires advance payment. Cash on Delivery is not available.</p>'+
      '<div class="lay" style="grid-template-columns:1fr 340px;margin-top:16px"><form data-s="order" class="glass stack" style="padding:20px">'+
      '<div class="two"><input name="name" placeholder="Full name" required autocomplete="name"><input name="phone" placeholder="01XXXXXXXXX" pattern="(\\+?88)?01[3-9][0-9]{8}" required autocomplete="tel"></div>'+
      '<input name="email" type="email" placeholder="Email (optional)">'+
      '<label>Delivery area<select name="delivery_zone" id="deliveryZone" required><option value="">Select delivery area</option><option value="inside">Inside Dhaka</option><option value="outside">Outside Dhaka</option></select></label>'+
      '<div class="two"><label>District<select name="district" required><option value="">Select district</option>'+BD_DISTRICTS.map(x=>'<option>'+esc(x)+'</option>').join("")+'</select></label><label>Thana / Upazila<select name="area" id="thanaSelect" required disabled><option value="">Select district first</option></select></label></div>'+
      '<textarea name="address" placeholder="House, road, area and full delivery address" required></textarea>'+
      '<div class="stack" style="border:1px solid var(--ln);border-radius:14px;padding:14px"><b>Choose your payment plan</b>'+
      '<label class="opt"><input type="radio" name="payment_type" value="delivery_first" checked><span><b>Delivery Charge First</b><br><span class="mut">Pay delivery charge now. Pay the product balance when the parcel is delivered.</span><br><b id="ijDeliveryPay">'+money(a.fee)+'</b></span></label>'+
      '<label class="opt"><input type="radio" name="payment_type" value="full_advance"><span><b>Full Advance Payment</b><br><span class="mut">Pay the full order amount now and save ৳30.</span><br><b id="ijFullPay">'+money(b.total)+'</b></span></label></div>'+
      '<div class="note stack"><b>Send Money to IJAZ WEAR</b>'+accountRows()+'<p class="mut sm" style="margin:0">Use Send Money only. Never share your PIN or OTP. Payment is not confirmed until our team checks the receiving account.</p></div>'+
      '<label>Payment method<select name="payment_method" required><option value="bKash">bKash</option><option value="Nagad">Nagad</option></select></label>'+
      '<div class="two"><label>Sender number<input name="sender_number" placeholder="01XXXXXXXXX" pattern="(\\+?88)?01[3-9][0-9]{8}" required></label><label>Amount sent (৳)<input name="amount_sent" id="ijAmountSent" type="number" min="1" step="0.01" required placeholder="Enter amount sent"></label></div>'+
      '<label>Transaction ID (TrxID)<input name="transaction_id" minlength="4" maxlength="80" required autocomplete="off" placeholder="Enter the exact TrxID"></label>'+
      '<div class="note"><span class="mut">Expected payment now</span><b id="ijExpectedPay">'+money(a.fee)+'</b><span class="mut sm" id="ijBalanceNote">Remaining product balance: '+money(a.sub)+'</span></div>'+
      '<button class="pri" type="submit">Submit Order for Verification</button></form>'+
      '<div class="glass stack" style="padding:20px;align-content:start"><h3>Order Summary</h3>'+
      items.map(i=>'<div class="row sp"><span>'+esc(prod(i.id).name)+' <span class="mut">'+esc(i.opt)+' ×'+i.q+'</span></span><span>'+money(pr(prod(i.id))*i.q)+'</span></div>').join("")+
      '<hr style="border-color:var(--ln);width:100%"><div class="row sp"><span>Product subtotal</span><b>'+money(a.sub)+'</b></div>'+
      '<div class="row sp"><span>Delivery inside Dhaka</span><b>'+money(db.set.dhaka)+'</b></div><div class="row sp"><span>Delivery outside Dhaka</span><b>'+money(db.set.out)+'</b></div>'+
      '<div class="row sp"><span>Full advance discount</span><b class="ac">−৳30</b></div><p class="mut sm">The exact payment amount updates according to your selected delivery area.</p></div></div>';
  };

  const manualOrderView = () => {
    if(!nf)nf={name:"",phone:"",email:"",address:"",district:"Dhaka",area:"",type:"Manual",cnote:"",onote:"",courier:"",ddate:"",fee:null,pm:"bKash",trx:"",sender:"",amount_sent:"",paymentType:"delivery_first",rows:[{id:0,opt:"",q:1}]};
    const products=vis().filter(p=>p.stock>0);
    const items=nf.rows.filter(r=>r.id&&r.q>0);
    const sub=items.reduce((s,r)=>s+pr(prod(r.id))*r.q,0);
    const fee=nf.fee==null?feeFor(nf.district):Number(nf.fee);
    const type=nf.paymentType||"delivery_first";
    const disc=type==="full_advance"?Math.min(30,sub+fee):0;
    const total=Math.max(0,sub+fee-disc);
    const expected=type==="full_advance"?total:fee;
    const f=(k,p,t)=>'<input data-c="nf" data-f="'+k+'" type="'+(t||"text")+'" value="'+esc(nf[k]||"")+'" placeholder="'+esc(p)+'">';
    return '<div class="nogrid"><div class="glass stack" style="padding:20px"><h3 class="disp">Customer details</h3>'+
      '<div class="two"><label>Customer name'+f("name","Full name")+'</label><label>Customer phone'+f("phone","01XXXXXXXXX")+'</label></div>'+
      '<label>Customer address<textarea data-c="nf" data-f="address" placeholder="House, road, area">'+esc(nf.address)+'</textarea></label>'+
      '<div class="two"><label>District'+f("district","District")+'</label><label>Area / Thana'+f("area","Area / Thana")+'</label></div>'+
      '<div class="two"><label>Order source<select data-c="nf" data-f="type">'+["Manual","Phone call","Facebook","WhatsApp","Instagram","Walk-in"].map(x=>'<option '+(x===nf.type?"selected":"")+'>'+x+'</option>').join("")+'</select></label><label>Email'+f("email","Optional email")+'</label></div>'+
      '<label>Customer note'+f("cnote","Customer request")+'</label><label>Internal note'+f("onote","Private team note")+'</label></div>'+
      '<div class="glass stack" style="padding:20px"><h3 class="disp">Order details</h3>'+
      nf.rows.map((r,i)=>{const p=prod(r.id);return '<div class="nrow"><select data-c="nrow" data-f="id" data-i="'+i+'"><option value="0">Select product</option>'+
        products.map(x=>'<option value="'+x.id+'" '+(x.id==r.id?"selected":"")+'>'+esc(x.name)+' ('+x.stock+' in stock)</option>').join("")+
        '</select><select data-c="nrow" data-f="opt" data-i="'+i+'">'+(p?p.opts:["—"]).map(x=>'<option '+(x===r.opt?"selected":"")+'>'+esc(x)+'</option>').join("")+
        '</select><input data-c="nrow" data-f="q" data-i="'+i+'" type="number" min="1" value="'+r.q+'"><b>'+(p?money(pr(p)*r.q):"—")+'</b><button class="ab d" data-a="nrdel" data-i="'+i+'">✕</button></div>';}).join("")+
      '<button class="ab" data-a="nradd" style="width:max-content">+ Add product line</button>'+
      '<label>Payment plan<select data-c="nf" data-f="paymentType"><option value="delivery_first" '+(type==="delivery_first"?"selected":"") +'>Delivery Charge First</option><option value="full_advance" '+(type==="full_advance"?"selected":"") +'>Full Advance · Save ৳30</option></select></label>'+
      '<div class="two"><label>Payment method<select data-c="nf" data-f="pm"><option '+(nf.pm==="bKash"?"selected":"") +'>bKash</option><option '+(nf.pm==="Nagad"?"selected":"") +'>Nagad</option></select></label><label>Sender number'+f("sender","01XXXXXXXXX")+'</label></div>'+
      '<div class="two"><label>Transaction ID'+f("trx","bKash / Nagad TrxID")+'</label><label>Amount customer sent'+f("amount_sent","Expected "+expected,"number")+'</label></div>'+
      '<div class="note stack"><div class="row sp"><span>Subtotal</span><b>'+money(sub)+'</b></div><div class="row sp"><span>Delivery</span><b>'+money(fee)+'</b></div><div class="row sp"><span>Discount</span><b>−'+money(disc)+'</b></div><div class="row sp"><b>Order total</b><b>'+money(total)+'</b></div><div class="row sp"><b>Required advance</b><b class="ac">'+money(expected)+'</b></div><div class="row sp"><span>Remaining at delivery</span><b>'+money(Math.max(0,total-expected))+'</b></div></div>'+
      '<button class="pri" data-a="nsave" '+(can("edit")?"":"disabled") +'>Save order for payment verification</button></div></div>';
  };

  const paymentSettingsView = () => {
    const m=methods();
    return '<form data-s="paymentsettings" class="glass stack" style="padding:20px;max-width:650px"><h3 class="disp">Payment receiving accounts</h3>'+
      '<p class="mut">Enter the Personal bKash and Nagad numbers that receive customer Send Money payments. These numbers appear at checkout.</p>'+
      '<label>bKash receiving number<input name="bkash" value="'+esc(m[0].num)+'" placeholder="01XXXXXXXXX" required></label>'+
      '<label>Nagad receiving number<input name="nagad" value="'+esc(m[1].num)+'" placeholder="01XXXXXXXXX" required></label>'+
      '<div class="note"><b>Payment rules</b><p class="mut">No Cash on Delivery. Delivery Charge First or Full Advance with ৳30 discount on every order.</p></div>'+
      '<button class="pri">Save payment settings</button></form>';
  };

  const paymentsView = () => {
    if(!sbSession)return '<div class="glass" style="padding:20px">Sign in to view payment records.</div>';
    if(!window.__ijPayLoaded&&!window.__ijPayLoading){
      window.__ijPayLoading=true;
      (async()=>{
        try{
          const r=await sbClient.from("payment_records").select("*").order("created_at",{ascending:false});
          if(r.error)throw r.error;
          window.__ijPayRows=r.data||[];
          const ids=[...new Set(window.__ijPayRows.map(p=>p.order_id).filter(Boolean))];
          if(ids.length){
            const q=await sbClient.from("orders").select("id,legacy_id,customer_name,phone,total,subtotal,delivery_charge,payment_type,status,payment_status").in("id",ids);
            if(q.error)throw q.error;window.__ijPayOrders=q.data||[];
          }else window.__ijPayOrders=[];
          window.__ijPayLoaded=true;
        }catch(err){window.__ijPayError=err.message||"Could not load payments";window.__ijPayLoaded=true;}
        finally{window.__ijPayLoading=false;route(true);}
      })();
    }
    if(window.__ijPayLoading||!window.__ijPayLoaded)return '<div class="glass" style="padding:24px">Loading payment records…</div>';
    if(window.__ijPayError)return '<div class="glass" style="padding:20px"><b>Could not load payment records</b><p class="mut">'+esc(window.__ijPayError)+'</p><button class="ab" data-a="refreshPayments">Retry</button></div>';
    const rows=window.__ijPayRows||[],orders=window.__ijPayOrders||[];
    const pending=rows.filter(p=>p.status==="pending"||p.status==="amount_mismatch").length;
    const count=s=>rows.filter(p=>p.status===s).length;
    let html='<div class="cards"><div class="glass cd"><b>'+pending+'</b><span>Needs review</span></div><div class="glass cd"><b>'+count("verified")+'</b><span>Verified</span></div><div class="glass cd"><b>'+count("rejected")+'</b><span>Rejected</span></div><div class="glass cd"><b>'+count("amount_mismatch")+'</b><span>Amount mismatch</span></div></div>'+
      '<div class="glass tbl"><div class="row sp tb"><b>Payment verification queue</b><button class="ab" data-a="refreshPayments">Refresh</button></div><div class="tw"><table class="ot"><thead><tr><th>Order</th><th>Customer</th><th>Method / Sender</th><th>TrxID</th><th>Claimed</th><th>Expected</th><th>Status</th><th>Action</th></tr></thead><tbody>';
    if(!rows.length)html+='<tr><td colspan="8" class="mut" style="text-align:center;padding:24px">No payment claims yet.</td></tr>';
    rows.forEach(p=>{
      const o=orders.find(x=>x.id===p.order_id)||{};
      const local=db.orders.find(x=>Number(x.id)===Number(o.legacy_id));
      const expected=p.payment_type==="full_advance"?Number(o.total||0):Number(o.delivery_charge||0);
      const mismatch=Math.abs(Number(p.amount||0)-expected)>0.009;
      const status=mismatch&&p.status==="pending"?"amount_mismatch":p.status;
      const cls=status==="verified"?"g":status==="rejected"||status==="duplicate"?"r":"w";
      html+='<tr><td><b>'+esc(local?local.no:("Order "+(o.legacy_id||"")))+'</b></td>'+
        '<td>'+esc(o.customer_name||"—")+'<br><a class="ac" href="tel:'+esc(o.phone||"")+'">'+esc(o.phone||"")+'</a></td>'+
        '<td>'+methodName(p.payment_method)+'<br><span class="mut sm">'+esc(p.sender_number||"—")+'</span></td>'+
        '<td><code>'+esc(p.transaction_id)+'</code></td><td><b>'+money(p.amount)+'</b></td><td>'+money(expected)+'</td>'+
        '<td><span class="sb '+cls+'">'+esc(status)+'</span></td><td><div class="row">'+
        (local?'<button class="ab" data-a="vo" data-id="'+local.id+'">Open</button>':"")+
        (["pending","amount_mismatch"].includes(p.status)?'<button class="ab p" data-a="verifyPayment" data-id="'+p.id+'">Verify</button><button class="ab d" data-a="rejectPayment" data-id="'+p.id+'">Reject</button>':"")+
        '</div></td></tr>';
    });
    html+='</tbody></table></div></div><p class="mut sm" style="margin-top:12px">A TrxID is only a claim. Always confirm the exact amount and transaction in your own bKash / Nagad account before verifying.</p>';
    return html;
  };

  const refreshPayments=()=>{window.__ijPayLoaded=false;window.__ijPayLoading=false;window.__ijPayError="";route(true);};
  const localByLegacy=id=>db.orders.find(o=>Number(o.id)===Number(id));
  const verifyPayment=async d=>{
    if(!sbSession||!can("pay"))return toast("You do not have permission to verify payments.");
    const p=(window.__ijPayRows||[]).find(x=>x.id===d.id);
    if(!p)return toast("Payment record not found. Refresh the queue.");
    const o=(window.__ijPayOrders||[]).find(x=>x.id===p.order_id);
    if(!o)return toast("Related order not found.");
    const expected=p.payment_type==="full_advance"?Number(o.total||0):Number(o.delivery_charge||0);
    if(Math.abs(Number(p.amount||0)-expected)>0.009){
      const r=await sbClient.from("payment_records").update({status:"amount_mismatch",admin_note:"Claimed amount does not match the required advance."}).eq("id",p.id);
      if(r.error)return toast(r.error.message);
      toast("Amount mismatch. Do not confirm this order.");return refreshPayments();
    }
    const now=new Date().toISOString();
    const r=await sbClient.from("payment_records").update({status:"verified",verified_by:sbSession.user.id,verified_at:now,rejection_reason:null}).eq("id",p.id);
    if(r.error)return toast(r.error.message);
    const remaining=Math.max(0,Number(o.total||0)-Number(p.amount||0));
    const u=await sbClient.from("orders").update({payment_status:"paid",status:"confirmed",paid_amount:Number(p.amount||0),remaining_amount:remaining,payment_verified_at:now}).eq("id",o.id);
    if(u.error)return toast("Payment was marked verified, but order update failed: "+u.error.message);
    const local=localByLegacy(o.legacy_id);
    if(local){local.pay="paid";local.status="confirmed";local.adv=Number(p.amount||0);local.paid_amount=Number(p.amount||0);local.remaining_amount=remaining;local.payment_verified_at=now;local.hist=local.hist||[];local.hist.push({from:"pending_payment",to:"confirmed",by:role,at:Date.now(),reason:"Payment verified against receiving account."});commit();}
    toast("Payment verified and order confirmed.");refreshPayments();
  };
  const rejectPayment=d=>{
    const p=(window.__ijPayRows||[]).find(x=>x.id===d.id);if(!p)return toast("Payment record not found.");
    dlg('<h3 class="disp">Reject payment claim</h3><p class="mut">The order will remain unconfirmed. Add a reason for the customer follow-up.</p><form data-s="paymentreject" data-id="'+esc(p.id)+'" class="stack"><textarea name="reason" required placeholder="Wrong TrxID, amount mismatch, payment not received…"></textarea><div class="row"><button class="pri" type="submit">Reject payment</button><button type="button" data-a="x">Cancel</button></div></form>');
  };
  const saveReject=async(id,reason)=>{
    if(!sbSession||!can("pay"))throw new Error("You do not have permission to reject payments.");
    const p=(window.__ijPayRows||[]).find(x=>x.id===id);if(!p)throw new Error("Payment record not found.");
    const now=new Date().toISOString();
    const r=await sbClient.from("payment_records").update({status:"rejected",rejection_reason:reason,verified_by:sbSession.user.id,verified_at:now}).eq("id",id);
    if(r.error)throw r.error;
    const u=await sbClient.from("orders").update({payment_status:"rejected",status:"payment_failed"}).eq("id",p.order_id);
    if(u.error)throw u.error;
    const o=(window.__ijPayOrders||[]).find(x=>x.id===p.order_id),local=o&&localByLegacy(o.legacy_id);
    if(local){local.pay="failed";local.status="payment_failed";local.notes=local.notes||[];local.notes.push("Payment rejected: "+reason);commit();}
    $("#dlg").close();toast("Payment rejected. Contact the customer for a new payment reference.");refreshPayments();
  };

  const saveManualOrder=async()=>{
    let order=null;
    try{
      order=adminOrder(nf);
      await persistCustomerOrder(order);
      nf=null;at="orders";aq="pending_payment";route(true);toast("Order "+order.no+" saved for payment verification.");openOrd(order.id);
    }catch(err){
      if(order){db.orders=db.orders.filter(x=>x.id!==order.id);(order.items||[]).forEach(i=>{const p=prod(i.id);if(p)p.stock+=i.qty;});commit();}
      toast(err.message||"Could not save manual order.");
    }
  };
  adminOrder=function(n){
    if(!can("edit"))throw new Error("You do not have permission to create orders.");
    if(!sbSession)throw new Error("Admin cloud session is required to save a manual order.");
    const items=(n.rows||[]).filter(r=>r.id&&r.q>0);
    if(!items.length)throw new Error("Add at least one product.");
    if(!n.name.trim()||!n.address.trim()||!String(n.district).trim())throw new Error("Name, address and district are required.");
    if(!/^(\+?88)?01[3-9][0-9]{8}$/.test(String(n.phone).trim()))throw new Error("Enter a valid Bangladeshi mobile number.");
    for(const i of items){const p=prod(i.id),qty=items.filter(x=>x.id==i.id).reduce((a,b)=>a+b.q,0);if(!p||qty>p.stock)throw new Error("Not enough stock for "+(p?p.name:"this product"));}
    const type=n.paymentType||"delivery_first",q=quotePayment(items,type,n.district),expected=dueNow(q,type);
    if(!n.pm||!n.trx||String(n.trx).trim().length<4||!n.sender)throw new Error("Payment method, sender number and TrxID are required.");
    if(!Number(n.amount_sent)||Number(n.amount_sent)<=0)throw new Error("Enter the amount the customer says they sent.");
    items.forEach(i=>{prod(i.id).stock-=i.q;slog(i.id,-i.q,"manual order",role);});
    const id=Date.now()+Math.floor(Math.random()*1000),no=String((db.set.brand||"IJ").slice(0,2).toUpperCase())+String(id).slice(-8);
    const o={
      id:id,no:no,key:"manual-"+id,c:{name:n.name.trim(),phone:String(n.phone).trim(),email:n.email||"",district:String(n.district).trim(),area:n.area||"",address:n.address.trim(),payment_method:n.pm,transaction_id:n.trx,sender_number:n.sender,amount_sent:Number(n.amount_sent)},
      method:"manual_transfer",pm:n.pm,trx:clean(n.trx),sender_number:clean(n.sender),amount_sent:Number(n.amount_sent),
      payment_type:type,pay:"pending",status:"pending_payment",sub:q.sub,disc:q.disc,fee:q.fee,total:q.total,
      adv:expected,paid_amount:0,remaining_amount:q.total,src:n.type||"Manual",cnote:n.cnote||"",onote:n.onote||"",
      courier:n.courier||"",track:"",ddate:n.ddate||"",ts:Date.now(),
      items:items.map(i=>({id:i.id,name:prod(i.id).name,opt:i.opt,price:pr(prod(i.id)),qty:i.q})),
      hist:[{to:"pending_payment",by:role+" (manual order)",at:Date.now(),reason:"Manual order created; payment awaiting verification."}],
      notes:n.onote?[n.onote]:[],mgr:"",cloudSaved:false
    };
    db.orders.unshift(o);commit();return o;
  };

  const mergeSelectedOrders=async()=>{
    if(!can("edit"))return toast("You do not have permission to merge orders.");
    const ids=[...selIds];if(ids.length!==2)return toast("Select exactly two orders to merge.");
    const pair=ids.map(id=>db.orders.find(o=>o.id==id));if(pair.some(x=>!x))return toast("Selected order not found.");
    const a=pair[0],b=pair[1];
    if(a.c.phone!==b.c.phone||clean(a.c.address).toLowerCase()!==clean(b.c.address).toLowerCase())return toast("Orders must have the same customer phone and delivery address.");
    if([a,b].some(o=>["shipped","delivered","returned","cancelled","payment_failed"].includes(o.status)))return toast("Only active, unshipped orders can be merged.");
    if(!a.cloudId||!b.cloudId)return toast("Both orders must be saved in the cloud before merging.");
    const primary=a.ts<=b.ts?a:b,secondary=primary===a?b:a;
    try{
      const r=await sbClient.from("payment_records").select("*").in("order_id",[primary.cloudId,secondary.cloudId]);if(r.error)throw r.error;
      const payRows=r.data||[];
      const move=await sbClient.from("payment_records").update({order_id:primary.cloudId}).eq("order_id",secondary.cloudId);if(move.error)throw move.error;
      const all=[...(primary.items||[]),...(secondary.items||[])],merged=[];
      all.forEach(i=>{const key=String(i.id)+"|"+String(i.opt||"");const old=merged.find(x=>String(x.id)+"|"+String(x.opt||"")===key);if(old)old.qty+=Number(i.qty||1);else merged.push({...i,qty:Number(i.qty||1)});});
      const sub=merged.reduce((s,i)=>s+Number(i.price||0)*Number(i.qty||0),0);
      const disc=Number(primary.disc||0)+Number(secondary.disc||0),fee=Math.max(Number(primary.fee||0),Number(secondary.fee||0)),total=Math.max(0,sub-disc+fee);
      const paid=payRows.filter(p=>p.status==="verified").reduce((s,p)=>s+Number(p.amount||0),0);
      const confirmed=paid>=Math.min(total,fee);
      Object.assign(primary,{items:merged,sub:sub,disc:disc,fee:fee,total:total,adv:paid,paid_amount:paid,remaining_amount:Math.max(0,total-paid),payment_type:paid>=total?"full_advance":"delivery_first",pay:confirmed?"paid":"pending",status:confirmed?"confirmed":"pending_payment",notes:[...(primary.notes||[]),"Merged with "+secondary.no+"; payment history retained."],hist:[...(primary.hist||[]),{from:primary.status,to:confirmed?"confirmed":"pending_payment",by:role,at:Date.now(),reason:"Merged with "+secondary.no+".}]});
      secondary.status="cancelled";secondary.pay="merged";secondary.mergedInto=primary.cloudId;secondary.notes=[...(secondary.notes||[]),"Merged into "+primary.no+"; retained for history."];
      const del=await sbClient.from("order_items").delete().eq("order_id",primary.cloudId);if(del.error)throw del.error;
      const itemRows=merged.map(i=>({order_id:primary.cloudId,product_id:null,product_name:i.name,quantity:i.qty,unit_price:i.price,selected_options:{option:i.opt||""}}));
      if(itemRows.length){const ins=await sbClient.from("order_items").insert(itemRows);if(ins.error)throw ins.error;}
      const src=await sbClient.from("orders").update({merged_into:primary.cloudId,status:"cancelled",payment_status:"merged",legacy_data:secondary}).eq("id",secondary.cloudId);if(src.error)throw src.error;
      const dst=await sbClient.from("orders").update({subtotal:sub,delivery_charge:fee,total:total,payment_status:confirmed?"paid":"pending",status:confirmed?"confirmed":"pending_payment",payment_type:primary.payment_type,paid_amount:paid,remaining_amount:Math.max(0,total-paid),legacy_data:primary}).eq("id",primary.cloudId);if(dst.error)throw dst.error;
      selIds.clear();commit();toast("Orders merged. Payment history and TrxIDs were retained.");route(true);
    }catch(err){toast(err.message||"Could not merge orders.");}
  };

  window.IJAZPayment={checkout:checkoutView,neworderView:manualOrderView,paymentsView:paymentsView,paymentSettingsView:paymentSettingsView};
  try{const group=NAV.find(n=>n[0]==="g1");if(group&&group[4]&&!group[4].some(x=>x[0]==="payments"))group[4].push(["payments","Payment verification","pay"]);}catch(e){}
  A.nsave=saveManualOrder;
  A.refreshPayments=()=>{window.__ijPayLoaded=false;window.__ijPayLoading=false;window.__ijPayError="";route(true);};
  A.verifyPayment=verifyPayment;
  A.rejectPayment=rejectPayment;
  A.mergeSelectedOrders=mergeSelectedOrders;

  document.addEventListener("change",e=>{
    const form=e.target.closest&&e.target.closest('form[data-s="order"]');if(!form)return;
    if(e.target.id==="deliveryZone"||e.target.name==="payment_type"){
      const zone=form.querySelector('[name="delivery_zone"]').value||"inside";
      const type=form.querySelector('[name="payment_type"]:checked').value;
      const items=lines(),q=quotePayment(items,type,zone),expected=dueNow(q,type);
      const d=quotePayment(items,"delivery_first",zone),f=quotePayment(items,"full_advance",zone);
      const a=form.querySelector("#ijDeliveryPay"),b=form.querySelector("#ijFullPay"),x=form.querySelector("#ijExpectedPay"),bal=form.querySelector("#ijBalanceNote");
      if(a)a.textContent=money(d.fee);if(b)b.textContent=money(f.total);if(x)x.textContent=money(expected);
      if(bal)bal.textContent="Remaining at delivery: "+money(Math.max(0,q.total-expected));
    }
  },true);

  document.addEventListener("submit",async e=>{
    const form=e.target;if(!form||!form.dataset||!form.dataset.s)return;
    if(form.dataset.s==="paymentsettings"){
      e.preventDefault();e.stopImmediatePropagation();
      if(!sbSession||role!=="Owner")return toast("Owner permission required.");
      const d=Object.fromEntries(new FormData(form));
      if(!/^(\+?88)?01[3-9][0-9]{8}$/.test(clean(d.bkash))||!/^(\+?88)?01[3-9][0-9]{8}$/.test(clean(d.nagad)))return toast("Enter valid Bangladesh mobile numbers.");
      db.set.pmeth=[{n:"bKash",on:true,num:clean(d.bkash)},{n:"Nagad",on:true,num:clean(d.nagad)}];
      commit();toast("Payment receiving numbers saved.");route(true);return;
    }
    if(form.dataset.s==="paymentreject"){
      e.preventDefault();e.stopImmediatePropagation();
      try{await saveReject(form.dataset.id,clean(new FormData(form).get("reason")));}catch(err){toast(err.message||"Could not reject payment.");}
      return;
    }
    if(form.dataset.s==="order"){
      e.preventDefault();e.stopImmediatePropagation();
      const d=Object.fromEntries(new FormData(form)),zone=d.delivery_zone;
      if(!zone)return toast("Select a delivery area.");
      if(!d.district||!d.area||!d.address)return toast("Complete your delivery address.");
      if(!/^(\+?88)?01[3-9][0-9]{8}$/.test(clean(d.phone)))return toast("Enter a valid Bangladeshi phone number.");
      const account=methods().find(m=>m.n.toLowerCase()===clean(d.payment_method).toLowerCase());
      if(!account||!account.num)return toast("This receiving number is not configured yet. Please contact the store.");
      if(clean(d.transaction_id).length<4)return toast("Enter the exact Transaction ID.");
      if(!/^(\+?88)?01[3-9][0-9]{8}$/.test(clean(d.sender_number)))return toast("Enter the sender's valid mobile number.");
      if(!Number(d.amount_sent)||Number(d.amount_sent)<=0)return toast("Enter the amount sent.");
      const button=form.querySelector('button[type="submit"]');if(button){button.disabled=true;button.textContent="Submitting…";}
      const type=d.payment_type==="full_advance"?"full_advance":"delivery_first";
      const customer={name:clean(d.name),phone:clean(d.phone),email:d.email||"",district:clean(d.district),area:clean(d.area),address:clean(d.address),delivery_zone:zone,payment_method:d.payment_method,transaction_id:clean(d.transaction_id),sender_number:clean(d.sender_number),amount_sent:Number(d.amount_sent)};
      let order=null;
      try{
        order=createOrder(lines().map(i=>({...i})),customer,type,idem).o;
        await persistCustomerOrder(order);
        cart=[];idem=crypto.randomUUID();sv();
        try{localStorage.setItem("ij_last",JSON.stringify({no:order.no,ph:customer.phone}));}catch(err){}
        dlg('<button class="x" data-a="x" aria-label="Close">✕</button><span class="eyebrow">Payment submitted for verification</span><h3 class="disp">Thank you, '+esc(customer.name.split(" ")[0])+'</h3>'+
          '<div class="note stack"><b>Order '+esc(order.no)+'</b><span>Payment method: '+esc(customer.payment_method)+'</span><span>TrxID: <code>'+esc(customer.transaction_id)+'</code></span><span>Amount claimed: '+money(customer.amount_sent)+'</span><span>Expected advance: '+money(order.adv)+'</span><span class="mut">Your order will be confirmed only after we verify the transaction in our receiving account.</span></div>'+
          '<div class="row"><a class="btn pri" href="#/track" data-a="x">Track order</a><a class="btn" target="_blank" rel="noopener" href="'+wa(db.set)+'?text='+encodeURIComponent("Hello, my order "+order.no+" is awaiting payment verification.")+'">WhatsApp us</a></div>',"wide");
        location.hash="#/";
      }catch(err){
        if(order){db.orders=db.orders.filter(x=>x.id!==order.id);(order.items||[]).forEach(i=>{const p=prod(i.id);if(p)p.stock+=i.qty;});commit();}
        toast(err.message||"Could not submit order.");
        if(button){button.disabled=false;button.textContent="Submit Order for Verification";}
      }
    }
  },true);
  if(location.hash==="#/admin"||location.hash==="#admin")setTimeout(()=>route(true),0);
})();