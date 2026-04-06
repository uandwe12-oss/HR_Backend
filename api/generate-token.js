const { google } = require('googleapis');
const readline = require('readline');

const CLIENT_ID = '169258570035-c4qa4ifh2i0e52g2vr7l8bun76kck3c4.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:5000/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const scopes = ['https://www.googleapis.com/auth/drive.file'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
  prompt: 'consent'
});

console.log('\nOpen this URL in browser:\n');
console.log(authUrl);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('\nPaste the code here: ', async (code) => {
  const { tokens } = await oauth2Client.getToken(code);
  console.log('\nNEW REFRESH TOKEN:\n');
  console.log(tokens.refresh_token);
  rl.close();
});