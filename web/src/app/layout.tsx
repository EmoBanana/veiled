import "./globals.css";
import '@rainbow-me/rainbowkit/styles.css';
import { Providers } from "@/context/Providers";

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
      <body>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
