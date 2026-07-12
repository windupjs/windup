export default function Login() {
  return (
    <form>
      <input id="email" name="email" type="email" data-testid="login-email" placeholder="Seu e-mail" />
      <input id="senha" name="senha" type="password" data-testid="login-senha" />
      <button type="submit" data-testid="login-submit">Entrar</button>
    </form>
  );
}
