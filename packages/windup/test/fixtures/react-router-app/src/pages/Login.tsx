export function Login() {
  return (
    <form>
      <input id="email" name="email" type="email" data-testid="login-email" />
      <input id="password" name="password" type="password" data-testid="login-password" />
      <button type="submit" data-testid="login-submit">Sign in</button>
    </form>
  );
}
