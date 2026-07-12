export default function Products() {
  return (
    <div>
      <input name="busca" aria-label="Buscar produto" />
      <button data-test="add-to-cart">Adicionar ao carrinho</button>
      <a data-testid="cart-link" href="/checkout">Carrinho</a>
    </div>
  );
}
