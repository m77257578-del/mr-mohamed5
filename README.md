# منصة الأستاذ محمد عبد المقصود

## التشغيل على Windows

1. ثبّت Node.js 18 أو أحدث.
2. انسخ `env.example` إلى ملف باسم `.env`، ثم ضع كلمة مرور قوية للمعلم في `TEACHER_PASSWORD` (12 حرفاً على الأقل).
3. افتح PowerShell في مجلد المشروع وشغّل:

   ```powershell
   node server.js
   ```

4. افتح `http://localhost:3000` في المتصفح واترك نافذة الخادم مفتوحة.

لا تفتح `index.html` مباشرة ولا تستخدم Live Server؛ المنصة تحتاج خادم Node.js لواجهات API والملفات.

## البيانات والنسخ الاحتياطي

تُحفظ سجلات الطلاب والإعدادات في `data/db.json` والملفات المرفوعة في `data/uploads/`. احتفظ بنسخة احتياطية من مجلد `data`، ولا تشارك محتواه أو ملف `.env` علناً. ملفات البيانات المحلية مستثناة من Git عبر `.gitignore`.

الخادم يستخدم وحدات Node.js المدمجة ولا يحتاج إلى تثبيت حزم إضافية.

## النشر على Vercel مع Supabase

Vercel يستضيف الواجهة والـAPI معًا (Functions)، وSupabase يحفظ قاعدة البيانات والملفات بصورة دائمة. ملف `vercel.json` يوجّه طلبات API والملفات إلى `api/index.js`، و`supabase/schema.sql` ينشئ مخزن الحالة الخاص والخزانة الخاصة للملفات.

من لوحة المعلم انشر الكورس وحدد الصف والسعر والمدة، ثم اربط المحتوى والامتحانات به. الطالب يسجل أو يدخل، يطلب الكود عبر واتساب، وبعد استلام الدفع يولد المعلم كودًا خاصًا بالكورس ويرسله. يدخل الطالب الكود مرة واحدة من حسابه، وتبدأ مدة الكورس من وقت التفعيل. الموقع لا يعالج الدفع الإلكتروني.

1. أنشئ مشروع Supabase، ثم نفّذ محتوى `supabase/schema.sql` في SQL Editor.
2. في إعدادات Vercel أضف `SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` و`SESSION_SECRET` و`TEACHER_PASSWORD` كمتغيرات سرية لكل بيئة منشورة. لا تضع مفتاح service-role في الواجهة أو GitHub.
3. قبل أول زيارة للـAPI على Vercel، انقل البيانات والملفات المحلية مرة واحدة من جهازك: اضبط `SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` في بيئة PowerShell ثم شغّل `npm run migrate:supabase`. السكربت يرفض استبدال بيانات Supabase الموجودة. احتفظ بنسخة احتياطية من مجلد `data`.
4. ادفع التعديلات إلى GitHub وانشر جذر المستودع على Vercel (Import Project).
5. تحقّق من أن `https://اسم-مشروعك.vercel.app/api/public` يعيد اسم المنصة، ثم افتح الموقع من الهاتف.

لا ترفع `.env` أو مجلد `data` إلى المستودع. بعد النشر، يمكن تثبيت المنصة من المتصفح عبر HTTPS؛ تسجيل الدخول والمحتوى يحتاجان اتصالًا بالإنترنت.

## المساعد الذكي (Gemini — اختياري)

أنشئ مفتاحًا من https://aistudio.google.com/apikey ثم أضفه في Vercel: **Project > Settings > Environment Variables** باسم `GEMINI_API_KEY` (واختياريًا `GEMINI_MODEL`)، وأعد النشر Redeploy. بدون المفتاح يعمل المساعد بردود محلية محدودة.


## الدفع الإلكتروني (Kashier)

1. أنشئ حساب تاجر على https://merchant.kashier.io وخذ: Merchant ID (يبدأ بـ MID-) و**Payment API Key** و**Secret Key** من صفحة Integrations.
2. أضف في Vercel: `KASHIER_MID` و`KASHIER_API_KEY` (هو Payment API Key) و`KASHIER_SECRET_KEY` و`KASHIER_MODE` (`test` للتجربة ثم `live`)، ثم Redeploy.
3. المفاتيح التجريبية لا تعمل إلا مع `KASHIER_MODE=test`، والحقيقية لا تعمل إلا مع `live`.
4. جرّب كورس بسعر أكبر من صفر بكارت الاختبار 5123450000000008 وتاريخ 06/25 وCVV 100. عند نجاح الدفع يُفعَّل الكورس تلقائياً للطالب عبر الـWebhook.
5. الـWebhook يُرسَل تلقائياً لعنوان `/api/kashier/webhook` مع كل عملية دفع، ولا تحتاج تسجيله يدوياً.
