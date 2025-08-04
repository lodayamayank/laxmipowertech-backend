import mongoose from "mongoose";
const connectDB = async() =>{
    try{
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MONGO DB connected');
    }
    catch(error){
        console.error('Not connected',error.message)
    }
}

export default connectDB;