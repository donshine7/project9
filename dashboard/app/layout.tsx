import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '상상특허 · 업무 자동화 허브',
  description: 'Hiworks·Outlook (classic) 메일 운영과 한국특허 가출원·명세서 작성·중간사건 프로젝트를 연결하는 로컬 업무 허브',
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
