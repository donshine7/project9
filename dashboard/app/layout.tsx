import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '상상특허 · Outlook (classic) 운영 대시보드',
  description: 'Hiworks와 Outlook (classic) 메일 자동분류 정책, 실행 위치, 폴더, 운영 이력을 관리하는 로컬 대시보드',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
