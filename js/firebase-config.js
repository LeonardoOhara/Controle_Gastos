import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, onSnapshot, serverTimestamp, updateDoc, setDoc, getDoc, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyB4GQkmdoxPUBvhshLUzbS_WjYJ9Zttbpg",
  authDomain: "controlegasto-67d6e.firebaseapp.com",
  projectId: "controlegasto-67d6e",
  storageBucket: "controlegasto-67d6e.firebasestorage.app",
  messagingSenderId: "746199352578",
  appId: "1:746199352578:web:51dde9092ec768d633ae1b",
  measurementId: "G-JB7Z8PWLF1"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export {
  app, db, auth,
  collection, addDoc, deleteDoc, doc, onSnapshot, serverTimestamp, updateDoc, setDoc, getDoc, query, where, orderBy,
  signInWithEmailAndPassword, signOut, onAuthStateChanged
};

/* =========================================================
   CONFIGURAÇÃO OBRIGATÓRIA NO CONSOLE FIREBASE
   https://console.firebase.google.com → projeto controlegasto-67d6e

   1) Authentication → Sign-in method
      - habilite "E-mail/senha"

   2) Authentication → Users → Add user
      - informe e-mail e senha desejados
      - copie o UID do usuário criado

   3) Authentication → Settings → Authorized domains
      - certifique-se que localhost está listado

   4) Firestore Database → Regras (cole abaixo e substitua SEU_UID):

   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /transactions/{txId} {
         allow read, write: if request.auth.uid == "SEU_UID_AQUI";
       }
     }
   }
   ========================================================= */

