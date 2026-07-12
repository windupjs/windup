export default function Checkout() {
  return (
    <form>
      <input id="cep" name="cep" data-testid="checkout-cep" />
      <button id="finalizar" data-testid="checkout-finish">Finalizar compra</button>
    </form>
  );
}
