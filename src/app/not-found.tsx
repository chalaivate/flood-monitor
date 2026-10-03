import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-xl flex-col items-start gap-3 px-4 py-16">
      <p className="text-sm text-muted">ข้อผิดพลาด 404</p>
      <h1 className="text-2xl font-medium">ไม่พบหน้าที่ต้องการ</h1>
      <p className="text-text-2">ลิงก์อาจไม่ถูกต้อง หรือหน้านี้ถูกย้ายไปแล้ว</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Link href="/" className="fm-btn fm-btn-primary">
          กลับไปหน้าแดชบอร์ด
        </Link>
        <Link href="/map" className="fm-btn fm-btn-quiet">
          ดูแผนที่จุดวัด
        </Link>
      </div>
    </main>
  )
}
