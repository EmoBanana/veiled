import "./globals.css";

export const metadata = {
  title: "Veiled Protocol | Terminal",
  description: "Privacy-first Limit Orders",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
