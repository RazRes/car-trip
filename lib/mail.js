import nodemailer from 'nodemailer';

export const mailConfigured = env => !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

export async function sendMail({ to, subject, text }, env = process.env) {
  const port = Number(env.SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
  });
  await transport.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, subject, text });
}
