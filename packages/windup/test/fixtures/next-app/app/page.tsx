import { Hero } from "@/components/Hero";
export default function Home() {
  return (
    <main>
      <Hero />
      <a id="ver-produtos" href="/products" data-testid="link-products">Ver produtos</a>
    </main>
  );
}
